# Upstream proposal: a minimal transcript code-block render hook

一份可直接提交到 pi 上游（github.com/earendil-works/pi）的 issue 草稿。
提交前请核对最新版 pi 是否已经内置了等价能力；若已内置，本文档的结论应改为
"已解决"并把 pi-code-render 标记为 deprecated。

---

**Title**: Extension API: allow extensions to customize how code blocks render in the transcript

**Body**:

## Problem

Pi's extension API can add commands, shortcuts, and UI overlays, but there is no
supported way for an extension to change how the **assistant transcript** renders
markdown block-level content. The `MarkdownTheme` surface (via `getMarkdownTheme()`)
covers colors and the code-block indent, but not structure: a code block is always
rendered as a `codeBlockBorder` fence line, styled code lines, and a closing fence.

This matters for terminal ergonomics that many users currently work around:

- **Copy friction.** Code blocks are the most frequently copied artifact in a coding
  agent, but selecting around fences with a mouse is error-prone, and there is no
  keyboard path to "copy the last block".
- **Block boundaries.** In long transcripts, fence-colored rows are the only visual
  boundary; long code blocks swallow the conversation with no way to collapse them.

## What people do today

`pi-code-render` (npm: pi-code-render) monkey-patches
`Markdown.prototype.renderToken` / `render` / `handleMouse` to render transcript code
blocks as flush-edge cards with a `[COPY]` button and a click-to-toggle raw view.
It works — and ~all of its complexity exists *because* the integration point is a
private prototype rather than a hook:

- it re-derives click targets by scanning ANSI-stripped rows on every layout change;
- it uses zero-width anchors inside rendered rows because there is no object model
  to attach interactions to;
- it self-checks at startup (renders a fixed sample, asserts the card shape) and
  silently falls back to native rendering whenever a Pi release shifts renderer
  internals — because it knows it is standing on undocumented ground.

That last point is the core problem: every Pi release that touches `markdown.js`
can silently break a package whose entire observable behavior is "the transcript
looks right".

## Proposal

A deliberately minimal hook, roughly:

```ts
// MarkdownTheme, or a new Markdown options bag passed to assistant-message Markdown instances
interface MarkdownOptions {
  codeBlock?: (token: { text: string; lang?: string; info?: string }, ctx: {
    width: number;
  }) => string[];
}
```

Semantics that would make this viable for real packages:

1. Returning `undefined` keeps the native rendering (progressive enhancement, no
   all-or-nothing).
2. The hook receives the token *before* the native fence lines are emitted, and its
   returned lines are treated as the block's render (including for re-wrap and
   width changes).
3. Mouse events for the hook's rows are delivered to the hook (or the extension
   that registered it) rather than being interpreted as text selection first.

Even a first version without (3) would cover the purely visual half (cards,
collapse buttons, line-range previews); the copy interaction can already be built
today with `registerShortcut`.

## Alternative considered

Rendering cards as an overlay outside the transcript. This does not work: cards
must scroll and wrap with the transcript, and terminal scrollback is a flat grid —
there is no place to anchor interactive elements to previously rendered rows.

## Why upstream

This is one implementation of a thing at least three packages want (code cards,
collapsible long blocks, block-level "jump to next block" navigation). A tiny hook
would let those packages delete their prototype patches, keep working across Pi
releases, and stop re-deriving layout by scanning stripped rows.

---

*Prepared from the experience of building and maintaining pi-code-render; happy to
contribute a PR against the relevant renderer entry points.*
