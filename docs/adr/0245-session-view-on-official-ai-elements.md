---
type: ADR
id: "0245"
title: "The Session view on official AI Elements"
status: accepted
date: 2026-10-21
---

## Context

ADR 0241 installed the official shadcn/ui components and AI Elements and
planned to move each surface onto them one slice at a time. Slice S4 is the
coding Session view. That view has a virtualised history, a rich composer
built on inline references, and hand-rolled tool, reasoning, plan, subagent,
queue and usage parts. The product owner chose to move the Session view onto
the official parts. The layout rules of ADRs 0239 and 0240 and the existing
keyboard and focus contracts stay.

## Decision

| Session part | Built from |
| --- | --- |
| Prompt and response | `Message`, `MessageContent`; response actions (regenerate, copy, fork) and prompt actions (copy, edit) are `MessageActions`/`MessageAction` |
| Markdown and code | `MessageResponse` (hardened streamdown, ADR 0241 §4) through `SessionMarkdown`. Code is highlighted by streamdown's shiki plugin |
| Reasoning | `Reasoning`, `ReasoningTrigger`, `ReasoningContent`. Kubecode controls open and closed: it is open while reasoning streams and closed once done, and the reader's toggle wins. The element's own auto-open and auto-close timers stay off, so a reader who reopens it is not closed again |
| Tool calls | `Tool`, `ToolHeader` (localized `statusLabel`), `ToolContent`, `ToolInput` (localized label). Output is `ToolOutput` with a `CodeBlock` |
| Shell output | `CodeBlock` inside `ToolOutput` (Terminal is not published) |
| Errors | The failed Tool state (`output-error`). Its output stays in the `CodeBlock` under a localized Error heading (Stack Trace is not published) |
| Plan summary | `Plan` card: `PlanTitle`, progress in `PlanDescription`, and `PlanAction` to open the plan |
| Subagent | `Task`, `TaskTrigger`, `TaskContent`, `TaskItem` with a state `Badge` (Subagent is not published) |
| Prompt queue | `Queue`, `QueueSection`, `QueueList`, `QueueItem`, with `QueueItemAction` for send now, edit and remove. Edit stays in place. The actions also show on keyboard focus |
| Composer | The surface is `InputGroup` with `PromptInputTools`, `PromptInputBody` and `PromptInputSubmit` (send) |
| Usage meter | `Context` with its trigger, content header, body and footer, all with localized children. It opens on click, never on hover |
| Streaming indicator | `Shimmer` with a localized label, and `Spinner` for pending tools |
| Scrolling | The virtualised history (react-virtuoso) stays, with a jump-to-latest button in `ConversationScrollButton`'s place, wired to the existing `autoFollowRef` |

Points of detail:

- **Composer.** The `PromptInput` form shell is not used. The input is the
  inline-reference editor (contenteditable), not `PromptInputTextarea`.
  Context and attachments come from the Add context menu. The shell also
  renders a hidden upload input with a fixed English label. Slash commands,
  the model and mode controls, side questions, the queued send while a run
  is active, and the shared `StopButton` (busy and failed-stop announcement,
  ADR 0227) are unchanged.
- **Wikilinks.** They become same-page fragment links
  (`#kubecode-wikilink=`) that `SessionMarkdown` intercepts. The hardened
  protocols do not change.
- **Tool icons.** The per-tool icons are replaced by the Tool header's own
  glyph.
- **Localisation.** Every visible or accessible label comes from the
  `kubecode.session.*` keys and the existing keys. The tests render de-DE
  and check that no published English default shows.
- **Lazy loading.** The Session view loads lazily
  (`AgentSessionWorkspace.tsx` wraps it in `lazy`). Measured with
  `vite build`, the entry chunk went from 6,966,958 B (1,839,940 gz) to
  6,768,910 B (1,785,840 gz). The new `SessionWorkspace` chunk is
  457,590 B (86,390 gz).

Unpublished on 2026-10-21 and deferred: `@ai-elements/terminal`,
`@ai-elements/stack-trace`, `@ai-elements/subagent`, `@shadcn/trace`. No
dependency was added.

## Consequences

- The Session view uses the same parts as the prototypes and later slices.
  The S5 cleanup can drop the old `ai-action-card` grid styles and
  `MarkdownContent` once no other surface uses them.
- The first open of a Session waits for one lazy chunk.
- Long tool inputs are no longer truncated: the Code Block scrolls instead
  (output is still capped at 800 characters).
