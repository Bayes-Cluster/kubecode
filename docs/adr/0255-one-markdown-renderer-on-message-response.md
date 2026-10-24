---
type: ADR
id: "0255"
title: "One Markdown renderer: MessageResponse on every surface"
status: accepted
date: 2026-10-24
---

## Context

Two Markdown stacks shipped side by side. `src/components/MarkdownContent.tsx`
(react-markdown, remark-gfm, rehype-highlight, a KaTeX link hack rendered
through `SafeMarkup`) still drew the DM share preview, and the legacy
`index.css` block (`.ai-markdown`, `.ai-reasoning-markdown`, `.ai-math-*`,
`.chat-wikilink`, seventeen `.hljs-*` rules) wrapped even the official
`MessageResponse` output in the Session view, so streamdown's typography was
overridden there (ADR 0247's acceptance bar: the official component owns
structure and appearance). Issue #278 (UI2 B, under #276) closes this.

## Decision

### 1. One renderer, two adapters

Every Markdown surface renders through the official AI Elements
`MessageResponse` (hardened streamdown, ADR 0241 §4), reached through the two
existing Kubecode adapters:

- `channel/ConversationResponse` for General, DMs and the DM share preview
  (localized copy controls, inert images). The share preview is the official
  `Message from="user"` + `MessageContent` around it, as the researcher's own
  messages are, and passes the same `className="kubecode-message-body"` the
  General and DM call sites pass, so the response root is identical to
  General's until slice D deletes that rule. Its "exact text" is a read-only
  `Textarea` (it wraps, and nothing initialises while the disclosure is
  closed).
- `session/SessionMarkdown` for the Session (wikilinks, external-link opening).
  `AiMessage` no longer wraps it in `div.ai-markdown`; `ReasoningContent`
  loses the dead `ai-reasoning-markdown` class; the dead
  `kubecode-session-response(-content)` hook classes become test ids.
- A Markdown record in `resources/RecordPreview` is `MessageContent` +
  `MessageResponse` with the no-image hardening (`NO_IMAGE_STREAMDOWN_PROPS`):
  the official parts own the text size and the prose. The content keeps the
  `[overflow-wrap:anywhere]` layout utility so a long token wraps inside the
  reader.

The parts the adapters hand to streamdown live in
`src/kubecode/markdown/MarkdownParts.tsx`: the inert image is
`Badge variant="outline"` carrying the alt text; `strong` renders a real
`<strong>` on every surface (the Session included; streamdown's default is a
styled `span`).

### 2. Wikilinks are streamdown's link, not an InlineCitation

In the Session a wikilink is rendered by streamdown's own link component
(`defaultComponents.a`, which owns the look and wraps a long title) with only
the navigation intercepted (`preventDefault`, then the Session's handler). It
is a real anchor: reached by Tab, followed by Enter or a click. AI Elements
`InlineCitation` (installed, zero uses) was considered and rejected: it is a
hover card over cited web sources (hostname badge, carousel of sources) and
ADR 0236 defers it until the server marks cited spans, which it still does
not. A wikilink is navigation to a Workspace record, not a citation.
InlineCitation stays installed and unused, for the decision ADR 0236 reserved.

General, DMs, the share preview and record previews never parsed `[[…]]`:
`MessageItem`'s only reference handler (`openReference`) takes a typed
`ProjectContextRef`, which a free-text wikilink target cannot supply. They
still print the brackets as text; #278 does not invent navigation there.

### 3. Hardening stays in one place, and two rules return

`streamdown-hardening.ts` remains the one place markdown is hardened. Two
protections the deleted renderer had, and the first version of this slice
lost, are restored there and in the adapters:

- **KaTeX is bounded** as ADR 0229 §7 asks: `maxSize: 10`, `maxExpand: 100`,
  `trust: false`. `@streamdown/math`'s `createMathPlugin` exposes no KaTeX
  options, so its `[rehypeKatex, options]` tuple is rebuilt with them; no new
  dependency. `$\rule{500em}{500em}$` draws at 10em; a self-expanding macro
  errors instead of hanging.
- **Inline math follows the ADR 0229 §7 rules**: a single-dollar pair is math
  only when the opening `$` is not followed by whitespace, the closing one is
  not preceded by whitespace and not followed by a digit. micromark's
  `singleDollarTextMath` does not enforce this (it rendered "$5 and $10" as a
  formula), so `src/kubecode/markdown/inlineMath.ts` escapes every other
  single `$` in prose, never inside fenced code, code spans or `$$…$$`, and
  all three adapters run it before streamdown. Prices and shell variables stay
  text on every surface.

### 4. What is deleted

- `src/components/MarkdownContent.tsx`, `src/components/SafeMarkup.tsx` (its
  only user) and the utilities only they imported: `utils/chatWikilinks.ts`,
  `utils/mathMarkdown.ts`, `utils/markdownBlocks.ts`,
  `utils/regexCapabilities.ts`, `utils/blockNoteDirectMarkdown.ts` (only
  `mathMarkdown` imported it), plus `MarkdownContent.test.tsx`.
- `index.css` lines 623–792 (the whole `.ai-markdown` layer, `.ai-math-*`,
  `.chat-wikilink`, `.hljs-*`) and the sixteen `--syntax-highlight-*` tokens
  only those rules read. `kubecode.css` loses `.kubecode-inert-image` and the
  two `.kubecode-message-body .ai-markdown` margin rules.
- The `@layer base` text-selection allowlist listed `.ai-markdown` (and a
  `[data-testid="ai-message"]` nothing renders). streamdown marks neither its
  root nor paragraphs with `data-streamdown`, so the allowlist cannot key on
  streamdown; every adapter puts `data-prose=""` on the streamdown root and
  the rule names `[data-prose], [data-prose] *`. Prose in General, DMs, the
  share preview, record previews and the Session is selectable from one rule.

### 5. Dependencies

Removed from `package.json` (and the lockfile, with `pnpm install
--lockfile-only`; the worktree's `node_modules` is the shared checkout's and
was not pruned): `react-markdown` 10.1.0, `rehype-highlight` 7.0.2 (taking
`highlight.js` 11.11.1 and `lowlight` with it), `remark-gfm` ^4.0.1 as a
direct dependency (it stays in the tree as streamdown's own), and
`dompurify` 3.4.2 (only `SafeMarkup` used it). `katex` stays: `@streamdown/math`
depends on it and `streamdown-hardening.ts` imports its stylesheet.

Changes under `src/components/ai-elements`: `streamdown-hardening.ts` only
(the bounded math plugin of §3 and its header comment). Nothing under
`src/components/ui` changed.

## Consequences

- One parser, one sanitizer, one highlighter (shiki) and one math renderer on
  five surfaces; the DM share preview is, by test, the same DOM General renders
  for the same source (`src/kubecode/markdown/oneRenderer.test.tsx`), raw HTML
  and unsafe link protocols are neutralised on each of them, and `$5 and $10`
  stays text on each of them.
- Session typography is now streamdown's (its base size inside
  `MessageContent`'s `text-sm`, its own code and table surfaces) instead of
  the 13px legacy layer; Session emphasis is a real `<strong>`.
- The share preview's bubble chrome still differs from General until slice D:
  General overpaints the official user bubble through `ConversationMessage`'s
  CSS, which this slice does not own. The response inside is the same.
- `[data-prose]` is a Kubecode attribute on the adapters, so the selection
  rule depends on nothing a library may rename; it is recorded as an
  `exception-ok` row in the gaps audit.
- The Session still renders images (ADR 0241 §4); conversations and records
  do not (ADR 0229 §7). Making the Session inert is a separate decision.
- General and DMs keep printing `[[…]]` literally, as before #278.
