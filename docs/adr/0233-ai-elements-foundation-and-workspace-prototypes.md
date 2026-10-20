---
type: ADR
id: "0233"
title: "AI Elements as the Workspace component foundation, a Harness-aligned token layer, and fixture prototypes"
status: proposed
date: 2026-10-20
---

## Context

The Research Workspace rebuild (#229) asks for official shadcn AI Elements
compositions instead of handcrafted equivalents, with the DeepSeek Harness
repository as the visual reference for composer polish, reading density, and
panel proportions. ADR 0222 gave the Workspace one `Composer`; ADR 0227 gave it
one visual vocabulary (`--ws-*` tokens, `MemberIdentity`, `ReferenceChip`,
`ViewHeader`, `DecisionButton`, stop and pause). AI Elements ship as copyable
source written for Next.js and the Vercel `ai` SDK, with dependencies
(`ai`, `streamdown`, `use-stick-to-bottom`, `motion`, `nanoid`, Shiki,
`embla-carousel`) that Kubecode has no use for: there is no chat backend in the
browser, and a message's meaning stays with the Rust server's projections.
The first milestone (#230) must prove the approach on connected screens
before later slices (#231–#235) adopt it.

## Decision

### 1. Copied source, adapted, no new dependency

`src/components/ai-elements/` holds Workspace adaptations of AI Elements
components from the official registry (`https://registry.ai-sdk.dev/<name>.json`,
AI Elements 1.9.1, fetched 2026-10-20; documentation at
`https://ui.shadcn.com/docs/ai-elements`). Each file names its source and its
changes. Kubecode adds no npm dependency: Radix primitives come from the
existing `radix-ui` package, and the shadcn `collapsible` wrapper joins
`src/components/ui/`.

| Component | Taken | Adapted |
| --- | --- | --- |
| Conversation | log, content, empty state, scroll-to-latest | plain scroller instead of `use-stick-to-bottom`; follows new content only while the reader is at the end; named `role="log"`; button is `IconButton` with the new `latest` command glyph |
| Message | message, content, response, actions, toolbar | `from` is `self` or `member`; every message has an author (`MemberIdentity`); the researcher's own message is tinted, not right-aligned; `MessageResponse` is a reading container, not `streamdown`; delivery state (`pending`, `failed`) is an attribute |
| Prompt Input | card, header, body, footer, tools | only the card structure; the text box, keyboard/IME contract, mentions, send and stop stay in `Composer` (ADR 0222) |
| Inline Citation | citation, text, card, source, quote | Radix popover opened by a named button instead of a hover card; shows the citation number, not a URL host; sources are `ReferenceChip`s; list instead of carousel |
| Sources | collapsible, trigger, content, source | caller-worded count; a source is a `ReferenceChip`, not an external link |
| Chain of Thought | collapsible steps | presents recorded member activity, never private model reasoning; status in words; Radix controlled state instead of `use-controllable-state` |
| Tool | collapsible header, input, output | local `ToolState` instead of `ai` types; state is a `StatusBadge`; preformatted text instead of the Shiki code block |
| Task | collapsible list of items | presents a member's internal work steps; it is not a Kubecode Task and never admits, moves, or completes one |
| Queue | sections, list, items | focusable native scroller; state in words; no reorder/remove/attachment actions |
| Confirmation | requested / approved / rejected parts | a pending decision from the server projection (ADR 0232) rather than an `ai` tool approval; a labelled region, not an alert; actions are `DecisionButton`s |
| Loader, Shimmer, Suggestion | as published | the loader is a labelled status; shimmer uses CSS instead of `motion`; suggestions wrap, form a labelled group, and only fill the draft |

Every user-facing string is a prop supplied from the locale catalogs; the
published English defaults ("Used N sources", "Parameters", "Awaiting
Approval") are removed. Glyphs come from ADR 0227's semantic map.

### 2. Shared conventions

AI Elements compose the ADR 0227 primitives rather than restyling them:
authors are `MemberIdentity`, references `ReferenceChip`, decisions
`DecisionButton`, headings `ViewHeader`, states `StatusBadge`. shadcn `Badge`,
`Alert`, `Card`, `HoverCard`, `Carousel`, `ScrollArea`, `InputGroup` and
`Command` are not added. Styles are `kubecode-ai-*` classes in
`kubecode.css`, on the shared tokens, so every theme and both modes follow.

### 3. Token layer aligned with the Harness reference

Taken from the Harness `ui-theme` and `ui-conversation` styles and added to the
ADR 0227 `--ws-*` layer, expressed over the existing semantic colours (no new
palette):

- radii `--ws-radius-sm/md/lg` 8/12/16 px; the composer card
  `--ws-radius-composer` 20 px (Harness uses 28 px for a one-line card;
  ours carries reference chips and a control row);
- hairlines `--ws-hairline(-strong)` at 10%/16% of the text colour, drawn
  0.5 px, and a soft elevation `--ws-elevation-soft` (a shadow-drawn stroke, so
  it costs no layout) with a darker variant in dark mode;
- `--ws-surface-composer`, `--ws-surface-self`, `--ws-surface-quiet`,
  `--ws-accent-soft`;
- reading type `--ws-font-reading`: the UI size on a 24 px line at 14 px
  (Harness content leading);
- flow rhythm `--ws-flow-gap` 6 px between process rows and
  `--ws-flow-gap-response` 12 px between responses (Harness);
- proportions: conversation column `--ws-conversation-width` 760 px with the
  composer 32 px wider (Harness clamps 680–920 px; 760 px keeps research prose
  near 80 characters beside a 360 px inspector), navigation `--ws-panel-nav`
  248 px, inspector `--ws-panel-inspector` 360 px.

`--ws-reading-width` (72ch) stays for documents.

### 4. Prototypes on fixture data

`#/prototypes[?screen=general|agents|review][&state=default|busy|error|empty][&theme=light|dark][&lang=…][&from=general|agents]`
opens connected prototypes inside the app's style scope and outside the
Workspace shell, like the control matrix (ADR 0227 §4): General with research
materials and citations; concurrent member work with tool activity, a queue,
a named stop, and a pending decision; and a Task review with Overview,
Results, Activity, versioned evidence, accept and send back, and a Back to
where it was opened from. A banner marks fixture data; nothing is sent,
saved, or shared, and local results say "sample only". Navigation, inspector
and phone layouts are part of each screen.

### 5. Capability gaps: example features not exposed

File upload and drag-and-drop, speech input, model selection, message
branches and regenerate, web search toggles, URL citations, image
attachments, queue reordering, and restore of earlier states are left out,
because Kubecode does not support them in the Workspace (#229). A suggestion
fills the draft and never sends; a mention notifies and never authorizes; a
direct message stays private and its material is shown as unavailable until
shared through the previewed sharing flow.

### 6. Relation to accepted ADRs

This partially supersedes ADR 0227 §2 for proportions — the composer card,
conversation width, panel widths, radii, hairlines and elevation are now the
tokens above — and ADR 0222 §1 for the composer's outer surface, which is the
Prompt Input card when a view adopts it. The `Composer`'s behaviour,
keyboard/IME contract, and the rest of both ADRs stand.

## Consequences

Later slices build views from one set of compositions and tokens; a view that
needs a message, citation, activity row, queue, or confirmation takes it from
`src/components/ai-elements/`. Upstream AI Elements updates are not pulled
automatically; an update is a reviewed copy with the adaptations re-applied.
Production views are not migrated by this decision. The prototypes are a
development route and add a lazily loaded chunk only.
