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
const COPY_LABEL = "[Copy]";
const STATUS_KEY = "pi-code-render";
const STATUS_CLEAR_MS = 2000;

/** Left/right padding inside a code card, in terminal columns. */
const CARD_PAD = "  ";

type CodeToken = { type?: string; lang?: string; text?: string };
type CodeBlock = {
  language: string;
  source: string;
  /** Line count produced for the card presentation. */
  cardLines?: number;
  /** Line count produced for the original fenced presentation. */
  rawLines?: number;
  raw?: boolean;
};
type BlockRange = { startY: number; endY: number; index: number };
type CopyHit = { y: number; startX: number; endX: number; source: string };
type Gesture = { x: number; y: number; source?: string; index?: number };
type LayoutCache = { key: string; hits: CopyHit[]; ranges: BlockRange[]; lines: string[] };

type MarkdownWithPrivateRenderer = Markdown & {
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

const LANGUAGE_LABELS: Record<string, string> = {
  bash: "Shell",
  c: "C",
  cpp: "C++",
  css: "CSS",
  go: "Go",
  html: "HTML",
  java: "Java",
  javascript: "JavaScript",
  js: "JavaScript",
  json: "JSON",
  jsx: "JSX",
  markdown: "Markdown",
  md: "Markdown",
  python: "Python",
  py: "Python",
  rust: "Rust",
  sh: "Shell",
  shell: "Shell",
  sql: "SQL",
  ts: "TypeScript",
  tsx: "TSX",
  typescript: "TypeScript",
  yaml: "YAML",
  yml: "YAML",
};

function displayLanguage(language: string): string {
  return LANGUAGE_LABELS[language.toLowerCase()] ?? (language || "Code");
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

  blocks.forEach((block, index) => {
    // Each block is anchored by its own marker (card header or raw fence opener)
    // and bounded by the exact line count renderToken produced for it.
    let y = cursor;
    if (block.raw) {
      while (y < plainLines.length && !plainLines[y]?.trim().startsWith("```")) y++;
      if (y >= plainLines.length) return;
      const endY = y + Math.max(1, block.rawLines ?? 1) - 1;
      ranges.push({ startY: y, endY, index });
      cursor = endY + 1;
      return;
    }

    const label = displayLanguage(block.language);
    // The card header is exactly: leading whitespace, the language label, a gap,
    // the copy button, trailing whitespace. Prose that merely mentions the label
    // and button on one line must not match (it breaks the click hit-testing).
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const anchor = new RegExp(`^\\s*${escapedLabel}\\s+\\[Copy\\]\\s*$`);
    while (y < plainLines.length && !anchor.test(plainLines[y] ?? "")) y++;
    if (y >= plainLines.length) return;

    const line = plainLines[y] ?? "";
    const startX = visibleWidth(line.slice(0, line.lastIndexOf(COPY_LABEL)));
    const endY = y + Math.max(1, block.cardLines ?? 1) - 1;
    hits.push({ y, startX, endX: startX + copyButtonWidth, source: block.source });
    ranges.push({ startY: y, endY, index });
    cursor = endY + 1;
  });

  return { hits, ranges };
}

function buildCard(
  highlighted: readonly string[],
  language: string,
  cardWidth: number,
  codeIndent: string,
  bg: (value: string) => string,
  accent: (value: string) => string,
): string[] {
  const innerWidth = Math.max(1, cardWidth - CARD_PAD.length * 2);
  const buttonWidth = visibleWidth(COPY_LABEL);
  const gapWidth = Math.max(
    1,
    cardWidth - visibleWidth(`  ${language}`) - buttonWidth - CARD_PAD.length,
  );
  const header = `  ${language}${" ".repeat(gapWidth)}${accent(COPY_LABEL)}${CARD_PAD}`;
  const card = [fillRow("", cardWidth, bg), fillRow(header, cardWidth, bg), fillRow("", cardWidth, bg)];

  for (const codeLine of highlighted) {
    const alignedLine = codeLine.startsWith(codeIndent) ? codeLine.slice(codeIndent.length) : codeLine;
    const wrapped = wrapTextWithAnsi(alignedLine, innerWidth);
    for (const line of wrapped.length > 0 ? wrapped : [""]) {
      card.push(fillRow(`${CARD_PAD}${line}${CARD_PAD}`, cardWidth, bg));
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
  /** Blocks that survive cached renders (renderToken only fires on cold renders). */
  const knownBlocks = new WeakMap<Markdown, CodeBlock[]>();
  const copyHits = new WeakMap<Markdown, CopyHit[]>();
  const blockRanges = new WeakMap<Markdown, BlockRange[]>();
  /** Sources toggled to the raw fenced presentation; survives streaming text edits. */
  const rawSources = new WeakMap<Markdown, Set<string>>();
  const gestures = new WeakMap<Markdown, Gesture>();
  const layoutCache = new WeakMap<Markdown, LayoutCache>();

  const getText = (instance: Markdown): string =>
    (instance as unknown as { text?: string }).text ?? "";

  /**
   * User messages and thinking blocks pass a defaultTextStyle to Markdown;
   * assistant transcript text does not. Those contexts keep Pi's native
   * code-fence rendering instead of cards.
   */
  const isPlainTextContext = (instance: Markdown): boolean =>
    !!(instance as unknown as { defaultTextStyle?: unknown }).defaultTextStyle;

  const patchedRenderToken: MarkdownWithPrivateRenderer["renderToken"] = function (
    token,
    width,
    nextTokenType,
    styleContext,
  ) {
    if (token?.type !== "code") {
      return originalRenderToken.call(this, token, width, nextTokenType, styleContext);
    }

    const language = languageFromInfo(token.lang);

    if (isPlainTextContext(this)) {
      const normalized = language && token.lang !== language ? { ...token, lang: language } : token;
      return originalRenderToken.call(this, normalized, width, nextTokenType, styleContext);
    }

    const capture = captureBlocks.get(this);
    const blockIndex = capture?.length ?? 0;
    const block: CodeBlock = { language, source: token.text ?? "" };
    capture?.push(block);

    // Toggled blocks render as the original fenced text.
    if (rawSources.get(this)?.has(block.source)) {
      const rawRendered = originalRenderToken.call(this, token, width, nextTokenType, styleContext);
      block.raw = true;
      block.rawLines = rawRendered.length;
      return rawRendered;
    }

    // Markdown info strings can carry metadata (for example "js workflow");
    // highlight using the first word, which is the actual language identifier.
    const normalizedToken = language && token.lang !== language ? { ...token, lang: language } : token;
    const rendered = originalRenderToken.call(this, normalizedToken, width, nextTokenType, styleContext);

    const closingFence = rendered.findIndex(
      (line, index) => index > 0 && stripTerminalSequences(line).trim() === "```",
    );

    // Preserve Pi's native fallback if its Markdown output shape changes.
    if (closingFence < 1) {
      return rendered;
    }

    const theme = getTheme();
    const card = buildCard(
      rendered.slice(1, closingFence),
      displayLanguage(language),
      Math.max(1, width),
      (this as unknown as { theme?: { codeBlockIndent?: string } }).theme?.codeBlockIndent ?? "  ",
      (value) => theme.bg(CARD_BG, value),
      (value) => theme.fg("accent", value),
    );
    if (nextTokenType && nextTokenType !== "space") {
      card.push("");
    }
    block.cardLines = card.length;
    block.rawLines = rendered.length;
    return card;
  };

  const patchedRender: MarkdownWithPrivateRenderer["render"] = function (width) {
    const text = getText(this);
    const key = `${width}\u0000${text}`;
    const cached = layoutCache.get(this);
    if (cached?.key === key) {
      copyHits.set(this, cached.hits);
      blockRanges.set(this, cached.ranges);
      return cached.lines;
    }

    // Plain contexts (user messages, thinking) keep native rendering.
    if (isPlainTextContext(this)) {
      const lines = originalRender.call(this, width);
      layoutCache.set(this, { key, hits: EMPTY_HITS, ranges: EMPTY_RANGES, lines });
      copyHits.set(this, EMPTY_HITS);
      blockRanges.set(this, EMPTY_RANGES);
      knownBlocks.delete(this);
      return lines;
    }

    // Fast path: messages without code fences need no per-render bookkeeping.
    if (!text.includes("```")) {
      const lines = originalRender.call(this, width);
      layoutCache.set(this, { key, hits: EMPTY_HITS, ranges: EMPTY_RANGES, lines });
      copyHits.set(this, EMPTY_HITS);
      blockRanges.set(this, EMPTY_RANGES);
      knownBlocks.delete(this);
      return lines;
    }

    const currentBlocks: CodeBlock[] = [];
    captureBlocks.set(this, currentBlocks);
    const lines = originalRender.call(this, width);
    captureBlocks.delete(this);

    if (currentBlocks.length > 0) {
      knownBlocks.set(this, currentBlocks);
    } else if (!lines.some((line) => stripTerminalSequences(line).includes(COPY_LABEL))) {
      knownBlocks.delete(this);
    }

    const plainLines = lines.map((line) => stripTerminalSequences(line));
    const { hits, ranges } = locateBlocks(
      plainLines,
      knownBlocks.get(this) ?? [],
      visibleWidth(COPY_LABEL),
    );
    copyHits.set(this, hits);
    blockRanges.set(this, ranges);
    layoutCache.set(this, { key, hits, ranges, lines });

    const blocks = knownBlocks.get(this);
    const last = blocks?.[blocks.length - 1];
    if (last) setLatestCode(last.source);
    return lines;
  };

  const patchedHandleMouse: NonNullable<MarkdownWithPrivateRenderer["handleMouse"]> = function (event) {
    if (event.button !== "left") {
      return originalHandleMouse?.call(this, event);
    }

    // Only interact when a gesture is active or the press starts on a card;
    // otherwise fall through so Pi keeps normal text selection.
    const gesture = gestures.get(this);
    if (!gesture && event.type !== "press") {
      return originalHandleMouse?.call(this, event);
    }

    if (event.type === "press") {
      const hit = copyHits.get(this)?.find(
        (item) => item.y === event.y && event.x >= item.startX && event.x < item.endX,
      );
      if (hit) {
        gestures.set(this, { x: event.x, y: event.y, source: hit.source });
      } else {
        const range = blockRanges.get(this)?.find((item) => event.y >= item.startY && event.y <= item.endY);
        if (range) {
          gestures.set(this, { x: event.x, y: event.y, index: range.index });
        } else {
          gestures.delete(this);
          return originalHandleMouse?.call(this, event);
        }
      }
      return { handled: true, capture: true };
    }

    if (!gesture) return { handled: true };

    if (event.type === "drag" || event.type === "move") {
      if (event.x !== gesture.x || event.y !== gesture.y) gestures.delete(this);
      return { handled: true };
    }

    if (event.type === "release") {
      gestures.delete(this);
      if (event.x !== gesture.x || event.y !== gesture.y) return { handled: true };

      if (gesture.source !== undefined) {
        copyCode(gesture.source);
        return { handled: true };
      }
      if (gesture.index !== undefined) {
        const blocks = knownBlocks.get(this);
        const block = blocks?.[gesture.index];
        if (block) {
          const toggled = rawSources.get(this) ?? new Set<string>();
          if (toggled.has(block.source)) toggled.delete(block.source);
          else toggled.add(block.source);
          rawSources.set(this, toggled);
          layoutCache.delete(this);
          this.invalidate();
          return { handled: true, render: true };
        }
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

  pi.on("session_start", (_event, ctx) => {
    restore?.();
    restore = undefined;
    themeContext = undefined;
    latestCode = "";

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
    restore?.();
    restore = undefined;
    themeContext = undefined;
    latestCode = "";
    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = undefined;
    }
  });
}
