---
type: ADR
id: "0241"
title: "Official shadcn/ui and AI Elements as the component layer"
status: accepted
date: 2026-10-21
supersedes: "0233 §1 (copied source, no new dependency), §2 (shadcn Badge, Alert, Card, HoverCard, ScrollArea, InputGroup and Command not added) and §7 (Conversation, Queue, Confirmation, Tool and Task kept out of General and DMs); the matching component choices in 0236, 0238, 0239 and 0240"
---

## Context

ADR 0233 adapted 13 AI Elements from registry 1.9.1 as copied source with no
new dependency, left out several shadcn/ui components, and kept Conversation,
Queue, Confirmation, Tool and Task out of General and DMs. The Session view
uses no AI Elements. The result is a hand-rolled layer that drifts from the
official components the Workspace rebuild (#229) asks for. The researcher
decided to install the official shadcn/ui components and AI Elements with
their dependencies, for every Workspace surface and the Session view, one
slice at a time (S0 foundation, S1 General and DM, S2 Task inspector, Kanban
and Needs you, S3 Resources and Members, S4 Session view, S5 cleanup). The
layout decisions of ADRs 0239 and 0240 stay: a 75% thread, one centred dock,
chat alignment and quiet copy.

## Decision

### 1. Install path and upgrades

Components come from the shadcn CLI only, on the existing Radix base
(`radix-ui`; no Base UI migration):

- `pnpm dlx shadcn@latest add <name>` into `src/components/ui/`;
- `pnpm dlx shadcn@latest add @ai-elements/<name>` into
  `src/components/ai-elements/` (`components.json` names the registry
  `https://registry.ai-sdk.dev/{name}.json`).

An upgrade is a reviewed re-run of the CLI with `--dry-run` and `--diff`;
existing files are never overwritten without review. Kubecode's own edits to
an official file are few and each carries a `Kubecode (ADR 0241)` comment, so
a re-run's diff shows them. They are:

- localisation props where the published component has a fixed English
  string: `ToolHeader statusLabel`, `ToolInput label`, `ToolOutput
  resultLabel`/`errorLabel`, `PlanTrigger label`, `SheetContent closeLabel`,
  and `InlineCitationCardTrigger` children replacing the URL host;
- React 19 lint fixes with the same behaviour: `CodeBlockContent` keys its
  asynchronous highlight by input instead of resetting a ref during render;
  `InlineCitationCarouselIndex` reads the carousel through
  `useSyncExternalStore` instead of copying it into state from an effect;
  `Shimmer` uses motion's cached element components instead of creating one
  during render; `PromptInput` drops a file's `id` without an unused binding;
- streamdown hardening (§4) in `MessageResponse` and `ReasoningContent`.

Files that export helpers beside components keep the repository's existing
`react-refresh/only-export-components` exception, written as on `button.tsx`
and `tabs.tsx` ("shadcn/ui pattern"); no other rule is silenced.

The official files keep `lucide-react` icons (already a dependency) so a
re-run stays a clean diff; Kubecode call sites pass their own glyphs from the
ADR 0227 icon map where a component accepts children.

### 2. Components in S0

Added from `@shadcn`: card, badge, item, empty, avatar, separator,
scroll-area, hover-card, command, skeleton, spinner, kbd, sheet, alert,
field, input-group, button-group, accordion, sonner, attachment, bubble,
marker, message-scroller, and their registry dependencies label, progress and
carousel.

Added from `@ai-elements`: conversation, message, prompt-input, sources,
inline-citation, tool, reasoning, task, plan, queue, confirmation,
chain-of-thought, shimmer, suggestion, context, checkpoint, code-block.

Unavailable from the registries on 2026-10-21, recorded instead of written by
hand:

- `@shadcn/toast` does not exist for this style; on the Radix base the toast
  is `sonner`, which was added.
- `@shadcn/code-block` and `@shadcn/trace` are not published for the
  `new-york` style; the AI Elements `code-block` was added, and S4 reconsiders
  `trace` if it is published.
- `@ai-elements/subagent`, `@ai-elements/terminal` and
  `@ai-elements/stack-trace` are not in the registry; S4 uses Task, Tool and
  Code Block for subagents, shell output and errors unless they appear.
- `@ai-elements/loader` was listed by `view` but the CLI's `add` resolved it
  to a missing item; the Spinner covers loading in S0.

Already installed and not re-synced in S0: button, collapsible, dialog,
dropdown-menu, input, popover, select, switch, tabs, textarea, tooltip. The
CLI's newer versions change product look (sizes, focus rings, dark-mode
variants), so each is re-synced with the slice that restyles its surfaces.

### 3. Dependencies

Each is added because an official component imports it; versions as locked:

| Package | Version | Pulled in by |
| --- | --- | --- |
| `ai` | 6.0.312 (`^6`) | types (`UIMessage`, `ToolUIPart`, `ChatStatus`, `LanguageModelUsage`) in message, tool, confirmation, prompt-input, conversation, context. Pinned to v6: the registry's `context` does not compile against v7's `LanguageModelUsage`. No AI SDK runtime is used. |
| `streamdown` | 2.7.1 | Message and Reasoning markdown |
| `@streamdown/cjk`, `@streamdown/code`, `@streamdown/math` | 1.0.4, 2.0.0, 1.0.3 | streamdown plugins (CJK, highlighted code, KaTeX) |
| `rehype-harden` | 1.1.8 | Kubecode's hardened link/image protocols (§4); already a streamdown dependency |
| `shiki` | 4.5.0 | Code Block and streamdown code |
| `use-stick-to-bottom` | 1.1.6 | Conversation |
| `motion` | 14.5.0 | Shimmer |
| `cmdk` | 1.1.1 | Command, Prompt Input command |
| `nanoid` | 6.0.2 | Prompt Input attachments |
| `tokenlens` | 1.3.1 | Context (usage and cost) |
| `@radix-ui/react-use-controllable-state` | 1.3.0 | Reasoning, Chain of Thought |
| `embla-carousel-react` | 8.6.0 | Carousel (Inline Citation) |
| `sonner`, `next-themes` | 2.0.8, 0.4.6 | Sonner toast |
| `cn` | 0.5.0 | shadcn's class merger used by the new `ui` files |
| `@shadcn/react` | 0.3.1 | Message Scroller primitive |

`@streamdown/mermaid` was installed by the CLI and removed: diagrams are not a
Workspace feature and the renderer is large. `lucide-react`, `radix-ui`,
`class-variance-authority`, `katex` and `tailwind-merge` were already
dependencies.

### 4. Markdown hardening and math

`src/components/ai-elements/streamdown-hardening.ts` holds the one streamdown
configuration every official surface spreads: `skipHtml`, no `rehype-raw`
(sanitize then harden only), links and images limited to `http`, `https` and
`mailto`, data images off, the link-safety modal off (its strings are
English and the protocols are already limited), streamdown's table and code
copy/download controls off (their labels are English titles, not accessible
names; S1 brings them back through streamdown's `translations`), and KaTeX
with `$…$` inline math as in `MarkdownContent`. A regression test renders raw HTML (it stays
text), `javascript:`, `data:` and `file:` links (dropped), and inline and
display math (KaTeX). Product markdown (`MarkdownContent`, react-markdown)
is unchanged in S0; General and DM move to `MessageResponse` in S1, the
Session view in S4.

### 5. Theming

The shadcn variables already alias the semantic tokens globally
(`index.css`). Inside an element with `data-ws-components="official"`,
`kubecode.css` maps them onto the Workspace tokens: `--radius` →
`--ws-radius-sm`, `--card` → `--ws-surface-raised`, `--muted`/`--secondary` →
`--ws-surface-quiet`, `--accent` → `--ws-accent-soft`, `--border`/`--input`
→ `--ws-hairline-strong`, `--ring` → `--state-focus-ring`. Light and dark
follow the tokens; no palette is added. Product surfaces opt in when their
slice moves, so S0 changes no product view. Tailwind `dark:` variants in the
official files still follow the system preference rather than
`data-theme`; S1 adds a `dark` custom variant on `data-theme` when product
surfaces adopt them, because it also changes today's `ui/` buttons and
inputs. streamdown's class names are made visible to Tailwind with
`@source`.

### 6. Localisation

Kubecode call sites pass every visible or accessible string from the locale
catalogs through props, children, `aria-label` or `placeholder`. The
published English defaults remain in the official files only as fallbacks
that Kubecode never relies on; the prototype and control-matrix tests render
de-DE and fail if a known default (Submit, Stop, Parameters, Result, Toggle
plan, Thinking, Loading, the prompt placeholder) appears. Strings in
components not used yet (Context labels, carousel and message-branch
buttons, upload input, command dialog title) get props when their slice
adopts them.

### 7. Product compatibility during the migration

The ADR 0233 adaptations moved to `src/components/ai-elements/workspace/`
and are re-exported unchanged from `@/components/ai-elements`, so every
product call site compiles and renders as before. Each slice moves its
surfaces to the official files beside them; S5 deletes the adaptations and
their `kubecode-ai-*` CSS.

### 8. Prototypes and control matrix

`#/prototypes` is rebuilt on the official parts — Conversation, Message with
hardened `MessageResponse`, Prompt Input, Suggestion, Sources, Inline
Citation, Tool, Task, Chain of Thought, Confirmation, Queue, Plan,
Checkpoint, Attachment, Avatar, HoverCard, Badge, Alert, Empty, Item, Field
— and is the visual reference for S1–S4. `#/controls` keeps the ADR 0227
product controls and adds an official-components section showing each part
in its states.

### 9. Bundle

`vite build`, before (origin/main 73a6b56) → after:

| | Before | After |
| --- | --- | --- |
| Entry chunk | 6,934,731 B (1,833,267 gz) | 6,966,958 B (1,842,072 gz) |
| All JS | 6,979,822 B in 63 files (1,844,359 gz) | 17,807,354 B in 313 files (3,963,790 gz) |
| CSS | 272,026 B | 335,745 B |

The entry grows 32 KB (9 KB gzipped), mostly the new locale strings. The
official components load only with the lazy `#/controls` and `#/prototypes`
routes. The JS total grows because shiki ships one lazily imported chunk per
grammar and theme (Code Block creates its highlighter with only the
requested language) and streamdown emits a lazy Mermaid chunk; none is
fetched unless a page renders that language or diagram. The CSS grows with
the classes of the new components and streamdown. Each later slice records
its own delta; S4 keeps the Session-only components behind a lazy import.

## Consequences

- New components follow the CLI and its upgrades; local edits are few,
  marked and reviewed on every re-run.
- Eighteen new direct dependencies enter the supply chain; `ai` is used for
  types only.
- Until S5, two component sets exist side by side; the barrel keeps the
  product on the old set and the prototypes on the new one.
- Product markdown keeps `MarkdownContent` until S1 and S4 switch it to the
  hardened streamdown configuration.
