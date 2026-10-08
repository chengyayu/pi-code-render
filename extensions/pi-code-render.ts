import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getNativeClipboard,
  Key,
  Markdown,
  stripTerminalSequences,
  visibleWidth,
  wrapTextWithAnsi,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Constants and types
// ---------------------------------------------------------------------------

const PATCH = Symbol.for("pi-code-render.markdown-patch");
const CARD_BG = "toolSuccessBg" as const;
const COPY_LABEL = "[COPY]";
/**
 * Zero-width prefix on the rendered label: prose or inline code can end with
 * the literal `[COPY]`, and such a row would hijack the anchor search.
 */
const COPY_ANCHOR = `\u200b${COPY_LABEL}`;
/**
 * Zero-width mark on a raw block's opening fence row. Row scanning cannot find
 * that fence (`trim().startsWith("```")`) because Pi prefixes rows inside a
 * blockquote with its border, so the scan would run on and anchor the block to
 * a later block's fence.
 */
const RAW_ANCHOR = "\u2060";
const STATUS_KEY = "pi-code-render";
const STATUS_CLEAR_MS = 2000;

/** Left/right padding inside a code card, in terminal columns. */
const CARD_PAD = "  ";

type CodeToken = {
  type?: string;
  lang?: string;
  text?: string;
};

type CodeBlock = {
  source: string;
  /** Line count produced for the card presentation. */
  cardLines?: number;
  /** Line count produced for the original fenced presentation. */
  rawLines?: number;
  raw?: boolean;
};

type BlockRange = {
  startY: number;
  endY: number;
  index: number;
};

type CopyHit = {
  y: number;
  startX: number;
  endX: number;
  source: string;
};

type Gesture = {
  /** Copy-button source; set only when the press landed on the button. */
  source?: string;
  index: number;
  /** Source of the pressed block; a streaming update renumbers blocks. */
  blockSource: string;
};

type LayoutCache = {
  key: string;
  hits: CopyHit[];
  ranges: BlockRange[];
  lines: string[];
};

/**
 * `Omit` drops the private members before re-declaring them, so the
 * intersection does not collapse to `never`.
 */
type MarkdownWithPrivateRenderer = Omit<Markdown, "renderToken" | "render" | "handleMouse"> & {
  renderToken: (
    token: CodeToken,
    width: number,
    nextTokenType?: string,
    styleContext?: unknown,
  ) => string[];
  render: (width: number) => string[];
  handleMouse?: (event: TuiMouseEvent) => TuiMouseEventResult | undefined;
};

type PatchRecord = { restore: () => void };

const EMPTY_HITS: CopyHit[] = [];
const EMPTY_RANGES: BlockRange[] = [];

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function languageFromInfo(info: unknown): string {
  return typeof info === "string" ? info.trim().split(/\s+/, 1)[0] ?? "" : "";
}

function normalizeCodeToken(token: CodeToken, language: string): CodeToken {
  // Markdown info strings can include metadata (for example, "js workflow").
  return language && token.lang !== language ? { ...token, lang: language } : token;
}

/** Pad a styled line with the card background out to `width` columns. */
function fillRow(text: string, width: number, bg: (value: string) => string): string {
  const clipped =
    visibleWidth(text) <= width ? text : (wrapTextWithAnsi(text, Math.max(1, width))[0] ?? "");
  return bg(clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped))));
}

// ---------------------------------------------------------------------------
// Clipboard (native helper first, platform command as fallback)
// ---------------------------------------------------------------------------

function runCopyProgram(program: string, args: string[], source: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${program} timed out`));
    }, 3000);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${program} exited with code ${code ?? "unknown"}`));
    });
    child.stdin.end(source, "utf8");
  });
}

function platformCopyCommands(): Array<[string, string[]]> {
  switch (process.platform) {
    case "darwin":
      return [["pbcopy", []]];
    case "win32":
      return [["clip", []]];
    default: {
      const commands: Array<[string, string[]]> = [];
      if (process.env.WAYLAND_DISPLAY) commands.push(["wl-copy", []]);
      if (process.env.DISPLAY) {
        commands.push(["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]);
      }
      return commands;
    }
  }
}

async function writeClipboard(source: string): Promise<void> {
  const clipboard = getNativeClipboard();
  if (clipboard?.setText) {
    try {
      await clipboard.setText(source);
      return;
    } catch {
      // Fall back to the platform clipboard command when the native helper fails.
    }
  }
  let lastError: Error | undefined;
  for (const [program, args] of platformCopyCommands()) {
    try {
      await runCopyProgram(program, args, source);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error("Clipboard access is unavailable in this terminal");
}

// ---------------------------------------------------------------------------
// Markdown patch: code cards, copy button, raw-text toggle
// ---------------------------------------------------------------------------

/** Locate every code block in the rendered output and derive click targets. */
function locateBlocks(
  plainLines: readonly string[],
  blocks: readonly CodeBlock[],
  copyButtonWidth: number,
): { hits: CopyHit[]; ranges: BlockRange[] } {
  const hits: CopyHit[] = [];
  const ranges: BlockRange[] = [];
  let cursor = 0;

  for (const [index, block] of blocks.entries()) {
    let y = cursor;

    if (block.raw) {
      while (y < plainLines.length && !(plainLines[y] ?? "").includes(RAW_ANCHOR)) y++;
      if (y >= plainLines.length) continue;

      const endY = y + Math.max(1, block.rawLines ?? 1) - 1;
      ranges.push({ startY: y, endY, index });
      cursor = endY + 1;
      continue;
    }

    // The card opens with a blank padding row, then the code's first line
    // carries the right-aligned copy button. Anchor on that button row, which
    // is identified by the zero-width marker in the label.
    while (y < plainLines.length && !(plainLines[y] ?? "").includes(COPY_ANCHOR)) y++;
    if (y >= plainLines.length) continue;

    const line = plainLines[y] ?? "";
    const startX = visibleWidth(line.slice(0, line.lastIndexOf(COPY_ANCHOR)));
    const endY = y + Math.max(1, block.cardLines ?? 1) - 1;
    hits.push({ y, startX, endX: startX + copyButtonWidth, source: block.source });
    ranges.push({ startY: Math.max(cursor, y - 1), endY, index });
    cursor = endY + 1;
  }

  return { hits, ranges };
}

function buildCard(
  highlighted: readonly string[],
  cardWidth: number,
  codeIndent: string,
  bg: (value: string) => string,
  accent: (value: string) => string,
): string[] {
  const innerWidth = Math.max(1, cardWidth - CARD_PAD.length * 2);
  const buttonWidth = visibleWidth(COPY_LABEL);
  const align = (line: string): string =>
    line.startsWith(codeIndent) ? line.slice(codeIndent.length) : line;
  const firstLine = highlighted[0] === undefined ? "" : align(highlighted[0]);
  const firstLineWidth = Math.max(1, innerWidth - buttonWidth - CARD_PAD.length);
  const wrappedFirstLine = wrapTextWithAnsi(firstLine, firstLineWidth);
  const firstLineContent = wrappedFirstLine[0] ?? "";
  const gapWidth = Math.max(1, innerWidth - visibleWidth(firstLineContent) - buttonWidth);
  const card = [
    fillRow("", cardWidth, bg),
    fillRow(
      `${CARD_PAD}${firstLineContent}${" ".repeat(gapWidth)}${accent(COPY_ANCHOR)}${CARD_PAD}`,
      cardWidth,
      bg,
    ),
  ];

  for (const line of wrappedFirstLine.slice(1)) {
    card.push(fillRow(`${CARD_PAD}${line}${CARD_PAD}`, cardWidth, bg));
  }

  for (const line of highlighted.slice(1)) {
    const wrapped = wrapTextWithAnsi(align(line), innerWidth);
    for (const wrappedLine of wrapped.length > 0 ? wrapped : [""]) {
      card.push(fillRow(`${CARD_PAD}${wrappedLine}${CARD_PAD}`, cardWidth, bg));
    }
  }

  card.push(fillRow("", cardWidth, bg));
  return card;
}

function installPatch(
  getTheme: () => ExtensionContext["ui"]["theme"],
  copyCode: (source: string) => void,
  setLatestCode: (source: string) => void,
): () => void {
  const prototype = Markdown.prototype as unknown as MarkdownWithPrivateRenderer &
    Record<PropertyKey, PatchRecord | undefined>;
  prototype[PATCH]?.restore();

  const originalRenderToken = prototype.renderToken;
  const originalRender = prototype.render;
  const originalHandleMouse = prototype.handleMouse;

  const captureBlocks = new WeakMap<Markdown, CodeBlock[]>();
  /** Survives cached renders, where renderToken only fires on cold renders. */
  const knownBlocks = new WeakMap<Markdown, CodeBlock[]>();
  /**
   * Blocks toggled to raw, keyed by index and paired with their source so
   * streaming edits and byte-identical siblings stay independent.
   */
  const rawSources = new WeakMap<Markdown, Map<number, string>>();
  const gestures = new WeakMap<Markdown, Gesture>();
  /**
   * Instances whose captured release will echo a click event. Pi dispatches the
   * click itself after a captured release, and the release already acted, so
   * that echo is not a second activation.
   */
  const capturedEcho = new WeakSet<Markdown>();
  const layoutCache = new WeakMap<Markdown, LayoutCache>();

  const getText = (instance: Markdown): string =>
    (instance as unknown as { text?: string }).text ?? "";

  /**
   * User messages and thinking blocks pass a defaultTextStyle to Markdown;
   * assistant transcript text does not. Keep Pi's native rendering there.
   */
  const isPlainTextContext = (instance: Markdown): boolean =>
    !!(instance as unknown as { defaultTextStyle?: unknown }).defaultTextStyle;

  const cacheLayout = (
    instance: Markdown,
    key: string,
    lines: string[],
    hits: CopyHit[] = EMPTY_HITS,
    ranges: BlockRange[] = EMPTY_RANGES,
  ): string[] => {
    layoutCache.set(instance, { key, hits, ranges, lines });
    return lines;
  };

  const renderWithoutCards = (instance: Markdown, width: number, key: string): string[] => {
    const lines = originalRender.call(instance, width);
    knownBlocks.delete(instance);
    return cacheLayout(instance, key, lines);
  };

  const patchedRenderToken = function (
    this: Markdown,
    token: CodeToken,
    width: number,
    nextTokenType?: string,
    styleContext?: unknown,
  ): string[] {
    if (token?.type !== "code") {
      return originalRenderToken.call(this, token, width, nextTokenType, styleContext);
    }

    const language = languageFromInfo(token.lang);
    const capture = captureBlocks.get(this);
    const source = token.text ?? "";

    // Plain contexts (user messages, thinking) and empty tokens from stray or
    // unterminated fences keep Pi's native presentation.
    if (isPlainTextContext(this) || source.trim() === "") {
      return originalRenderToken.call(
        this,
        normalizeCodeToken(token, language),
        width,
        nextTokenType,
        styleContext,
      );
    }

    const index = capture?.length ?? -1;
    const block: CodeBlock = { source };
    capture?.push(block);

    // Toggled blocks render as the original fenced text.
    if (rawSources.get(this)?.get(index) === source) {
      const rawRendered = originalRenderToken.call(this, token, width, nextTokenType, styleContext);
      block.raw = true;
      // Pi re-wraps every token row at this width after renderToken returns, so
      // counting rawRendered.length ends the click range short and the bottom
      // of the raw block stops responding.
      block.rawLines = rawRendered.reduce(
        (total, line) => total + Math.max(1, wrapTextWithAnsi(line, width).length),
        0,
      );
      if (rawRendered.length > 0) rawRendered[0] = `${rawRendered[0] ?? ""}${RAW_ANCHOR}`;
      return rawRendered;
    }

    const rendered = originalRenderToken.call(
      this,
      normalizeCodeToken(token, language),
      width,
      nextTokenType,
      styleContext,
    );

    // Scan backwards for the closing fence: code content may itself contain
    // bare fence rows, and only the last one is the one Pi appended.
    let closingFence = -1;
    for (let lineIndex = rendered.length - 1; lineIndex > 0; lineIndex--) {
      if (stripTerminalSequences(rendered[lineIndex] ?? "").trim() === "```") {
        closingFence = lineIndex;
        break;
      }
    }

    if (closingFence < 1) return rendered; // Pi's output shape changed; bail out.

    const theme = getTheme();
    const card = buildCard(
      rendered.slice(1, closingFence),
      Math.max(1, width),
      (this as unknown as { theme?: { codeBlockIndent?: string } }).theme?.codeBlockIndent ?? "  ",
      (value) => theme.bg(CARD_BG, value),
      (value) => theme.fg("accent", value),
    );
    if (nextTokenType && nextTokenType !== "space") card.push("");
    // `card` starts with a blank padding row; the click anchor is the next row.
    block.cardLines = Math.max(1, card.length - 1);
    return card;
  };

  const patchedRender = function (this: Markdown, width: number): string[] {
    const text = getText(this);
    const key = `${width}\u0000${text}`;
    const cached = layoutCache.get(this);
    if (cached?.key === key) return cached.lines;

    // Plain contexts (user messages, thinking) keep native rendering.
    if (isPlainTextContext(this)) return renderWithoutCards(this, width, key);

    const currentBlocks: CodeBlock[] = [];
    captureBlocks.set(this, currentBlocks);
    let lines: string[];
    try {
      lines = originalRender.call(this, width);
    } finally {
      captureBlocks.delete(this);
    }

    // A message with no code tokens needs no per-render bookkeeping. Never key
    // this on the source text: an indented code block has no ``` but is still
    // rendered as a card.
    if (currentBlocks.length > 0) {
      knownBlocks.set(this, currentBlocks);
    } else if (!lines.some((line) => line.includes(COPY_ANCHOR) || line.includes(RAW_ANCHOR))) {
      knownBlocks.delete(this);
    }

    const blocks = knownBlocks.get(this) ?? [];
    if (blocks.length === 0) return cacheLayout(this, key, lines);

    const plainLines = lines.map((line) => stripTerminalSequences(line));
    const { hits, ranges } = locateBlocks(plainLines, blocks, visibleWidth(COPY_LABEL));

    const last = blocks[blocks.length - 1];
    if (last) setLatestCode(last.source);
    return cacheLayout(this, key, lines, hits, ranges);
  };

  const toggleRawBlock = (instance: Markdown, index: number): boolean => {
    const block = knownBlocks.get(instance)?.[index];
    if (!block) return false;

    const toggled = rawSources.get(instance) ?? new Map<number, string>();
    if (toggled.get(index) === block.source) toggled.delete(index);
    else toggled.set(index, block.source);
    rawSources.set(instance, toggled);
    layoutCache.delete(instance);
    instance.invalidate();
    return true;
  };

  const patchedHandleMouse = function (
    this: Markdown,
    event: TuiMouseEvent,
  ): TuiMouseEventResult | undefined {
    if (event.button !== "left") {
      return originalHandleMouse?.call(this, event);
    }

    // Only interact while a gesture is active, or on the press that starts one,
    // or on a click Pi dispatches from its own selection path.
    const gesture = gestures.get(this);
    if (!gesture && event.type !== "press" && event.type !== "click") {
      return originalHandleMouse?.call(this, event);
    }

    const layout = layoutCache.get(this);
    const rangeAt = (y: number): BlockRange | undefined =>
      layout?.ranges.find((item) => y >= item.startY && y <= item.endY);

    if (event.type === "press") {
      capturedEcho.delete(this);
      const range = rangeAt(event.y);
      const block = range ? knownBlocks.get(this)?.[range.index] : undefined;
      if (!range || !block) {
        gestures.delete(this);
        return originalHandleMouse?.call(this, event);
      }
      // A raw block is selectable text, so only its opening fence row is a
      // click target. Leaving the code to Pi keeps drag-to-select working; a
      // plain click there comes back as a click event (see below).
      if (block.raw && event.y !== range.startY) {
        gestures.delete(this);
        return originalHandleMouse?.call(this, event);
      }
      const hit = layout?.hits.find(
        (item) => item.y === event.y && event.x >= item.startX && event.x < item.endX,
      );
      gestures.set(this, { source: hit?.source, index: range.index, blockSource: block.source });
      return { handled: true, capture: true };
    }

    // Pi dispatches a click for a press it kept for text selection, which is how
    // a raw block stays selectable and still collapses on a plain click. The
    // echo of our own captured release is not a second activation: the release
    // already toggled, and by now the block reads as raw either way.
    if (event.type === "click") {
      if (capturedEcho.delete(this)) return originalHandleMouse?.call(this, event);
      // Pi counts multi-clicks here too, and those select a word or a line.
      // Folding the block on the second click would throw that selection away.
      if ((event.clickCount ?? 1) > 1) return originalHandleMouse?.call(this, event);
      const range = rangeAt(event.y);
      const block = range ? knownBlocks.get(this)?.[range.index] : undefined;
      if (range && block?.raw && toggleRawBlock(this, range.index)) {
        return { handled: true, render: true };
      }
      return originalHandleMouse?.call(this, event);
    }

    if (!gesture) return { handled: true };

    // Motion is not a cancellation: a held button makes terminals report
    // movement at cell granularity, so an ordinary click routinely arrives as
    // press, drag, release. The release below decides. Motion changes nothing,
    // and Pi renders on every drag unless told otherwise.
    if (event.type === "drag" || event.type === "move") {
      return { handled: true, render: false };
    }

    if (event.type === "release") {
      gestures.delete(this);
      const range = rangeAt(event.y);
      const block = range ? knownBlocks.get(this)?.[range.index] : undefined;
      // A release that left the pressed card is a drag; a changed source means
      // a streaming update renumbered the blocks under the pointer.
      if (!range || range.index !== gesture.index || block?.source !== gesture.blockSource) {
        return { handled: true };
      }

      capturedEcho.add(this);
      if (gesture.source !== undefined) {
        copyCode(gesture.source);
        return { handled: true };
      }
      if (toggleRawBlock(this, gesture.index)) {
        return { handled: true, render: true };
      }
    }

    return { handled: true };
  };

  prototype.renderToken = patchedRenderToken;
  prototype.render = patchedRender;
  prototype.handleMouse = patchedHandleMouse;

  const record: PatchRecord = {
    restore() {
      if (prototype.renderToken === patchedRenderToken) prototype.renderToken = originalRenderToken;
      if (prototype.render === patchedRender) prototype.render = originalRender;
      if (prototype.handleMouse === patchedHandleMouse) {
        if (originalHandleMouse) prototype.handleMouse = originalHandleMouse;
        else delete prototype.handleMouse;
      }
      if (prototype[PATCH] === record) delete prototype[PATCH];
    },
  };
  prototype[PATCH] = record;
  return record.restore;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let restore: (() => void) | undefined;
  let themeContext: ExtensionContext | undefined;
  let latestCode = "";
  let statusTimer: ReturnType<typeof setTimeout> | undefined;

  /** Transient footer feedback; ui.notify("info") would persist in the transcript. */
  const showCopiedStatus = (message: string) => {
    const ctx = themeContext;
    if (!ctx) return;
    try {
      if (statusTimer) clearTimeout(statusTimer);
      ctx.ui.setStatus(STATUS_KEY, message);
      statusTimer = setTimeout(() => {
        statusTimer = undefined;
        try {
          ctx.ui.setStatus(STATUS_KEY, undefined);
        } catch {
          // Stale ctx after reload or session replacement; nothing to clear.
        }
      }, STATUS_CLEAR_MS);
    } catch {
      // Stale ctx; fall back silently.
    }
  };

  const copyCode = async (source: string, ctx: ExtensionContext) => {
    try {
      await writeClipboard(source);
      showCopiedStatus("Code copied");
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
    }
  };

  pi.registerShortcut(Key.ctrlAlt("c"), {
    description: "Copy the most recently rendered code block",
    handler: async (ctx) => {
      if (!latestCode) {
        ctx.ui.notify("No code block to copy", "warning");
        return;
      }
      await copyCode(latestCode, ctx);
    },
  });

  /** Reset session-scoped state; safe to run when no session is active. */
  const resetSessionState = () => {
    restore?.();
    restore = undefined;
    themeContext = undefined;
    latestCode = "";
    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = undefined;
    }
  };

  pi.on("session_start", (_event, ctx) => {
    resetSessionState();
    if (ctx.mode !== "tui") return;

    themeContext = ctx;
    restore = installPatch(
      () => {
        if (!themeContext) throw new Error("pi-code-render has no active TUI theme");
        return themeContext.ui.theme;
      },
      (source) => {
        if (themeContext) void copyCode(source, themeContext);
      },
      (source) => {
        latestCode = source;
      },
    );
  });

  pi.on("session_shutdown", () => {
    resetSessionState();
  });
}
