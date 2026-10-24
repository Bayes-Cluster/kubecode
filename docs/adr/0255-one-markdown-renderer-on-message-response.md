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
  messages are; its "exact text" is `CodeBlock language="text"`.
- `session/SessionMarkdown` for the Session (wikilinks, external-link opening).
  `AiMessage` no longer wraps it in `div.ai-markdown`, and `ReasoningContent`
  loses the dead `ai-reasoning-markdown` class.
- A Markdown record in `resources/RecordPreview` is `MessageContent` +
  `MessageResponse` with the no-image hardening (`NO_IMAGE_STREAMDOWN_PROPS`):
  the official parts own the text size and the prose; no `text-sm` div.

The parts both adapters hand to streamdown live in
`src/kubecode/markdown/MarkdownParts.tsx`: the inert image is
`Badge variant="outline"` carrying the alt text; `strong` stays `strong`.
`streamdown-hardening.ts` remains the one place markdown is hardened; only
its header comment changed (it named `MarkdownContent`).

### 2. Wikilinks are a Badge, not an InlineCitation

A wikilink is `Badge asChild variant="secondary"` around the real anchor
(`WikilinkBadge`): it is reached by Tab, followed by Enter or a click, and
the Badge owns its appearance. AI Elements `InlineCitation` (installed, zero
uses) was considered and rejected: it is a hover card over cited web sources
(hostname badge, carousel of sources) and ADR 0236 defers it until the server
marks cited spans, which it still does not. A wikilink is navigation to a
Workspace record, not a citation; using InlineCitation for it would fabricate
a citation position. InlineCitation stays installed and unused, for the
decision ADR 0236 reserved.

### 3. What is deleted

- `src/components/MarkdownContent.tsx`, `src/components/SafeMarkup.tsx` (its
  only user) and the utilities only they imported: `utils/chatWikilinks.ts`,
  `utils/mathMarkdown.ts`, `utils/markdownBlocks.ts`,
  `utils/regexCapabilities.ts`, plus `MarkdownContent.test.tsx`.
- `index.css` lines 623–792 (the whole `.ai-markdown` layer, `.ai-math-*`,
  `.chat-wikilink`, `.hljs-*`) and the sixteen `--syntax-highlight-*` tokens
  only those rules read. `kubecode.css` loses `.kubecode-inert-image` and the
  two `.kubecode-message-body .ai-markdown` margin rules.
- The `@layer base` text-selection allowlist listed `.ai-markdown` and its
  children; it now lists `[data-streamdown]` and its children, so prose in
  General, DMs, record previews and the Session is selectable from one rule.

### 4. Dependencies

Removed from `package.json` (and the lockfile, with `pnpm install
--lockfile-only`; the worktree's `node_modules` is the shared checkout's and
was not pruned): `react-markdown` 10.1.0, `rehype-highlight` 7.0.2 (taking
`highlight.js` 11.11.1 and `lowlight` with it), `remark-gfm` ^4.0.1 as a
direct dependency (it stays in the tree as streamdown's own), and
`dompurify` 3.4.2 (only `SafeMarkup` used it). `katex` stays: `@streamdown/math`
depends on it and `streamdown-hardening.ts` imports its stylesheet.

No file under `src/components/ui` or `src/components/ai-elements` changed
apart from the comment in `streamdown-hardening.ts`.

## Consequences

- One parser, one sanitizer, one highlighter (shiki) and one math renderer on
  five surfaces; the DM share preview is, by test, the same DOM General renders
  for the same source (`src/kubecode/markdown/oneRenderer.test.tsx`), and raw
  HTML and unsafe link protocols are neutralised on each of them.
- Session typography is now streamdown's (16px base inside `MessageContent`'s
  `text-sm`, its own code and table surfaces) instead of the 13px legacy layer.
- `[data-streamdown]` is a streamdown attribute; the selection rule depends on
  it the way the existing rule depends on `pre` and `code`.
- The Session still renders images (ADR 0241 §4); conversations and records
  do not (ADR 0229 §7). Making the Session inert is a separate decision.
