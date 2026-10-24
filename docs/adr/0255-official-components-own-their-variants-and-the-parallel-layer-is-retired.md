---
type: ADR
id: "0255"
title: "Official components own their variants; the parallel component layer is retired"
status: accepted
date: 2026-10-24
supersedes: "0247 §2 (the table of thin wrappers), §4 (what the CSS ownership check sees) and §5 (the AI Elements registry URL); 0241 §1 (the registry URL) and §2 (the catalogue of 2026-10-21)"
---

## Context

The audit in `docs/design/shadcn-remaining-gaps.md` (2026-10-24) found 320
open findings after the #254 programme. Nearly every one routes through a
small set of project wrappers in `src/components/workspace/` that owned
typography, size and colour through `kubecode.css`, or through a per-call
`className` that resized an official part (`pointer-coarse:min-h-[44px]`,
`Empty className="p-4"`, `h-auto p-0` on a link Button). Issue #276 opens a
second programme (UI2, slices A–L); this ADR is slice A (#277), the only
slice that changes `src/components/ui/*` and `src/components/ai-elements/*`
on purpose.

## Decision

### 1. Ownership

An official shadcn/ui or AI Elements component renders the structure and its
variants render the appearance. A `className` that changes the size,
padding, border, radius, font or colour of an official part is a defect.
Layout utilities (flex, grid, gap, width, margin, position, truncation) are
not. Sizes and tones live in the component once, as a `size` or `variant`,
never per call site. A project wrapper may survive only as a documented
pass-through: it chooses variants and carries a domain or accessibility
contract, and it has no CSS of its own.

### 2. Variants added to official files

Each carries a `Kubecode (ADR 0255)` comment so a CLI re-run's diff shows it.

| File | Change |
| --- | --- |
| `ui/button.tsx` | Base: `pointer-coarse:min-h-[44px]`; icon sizes also `pointer-coarse:min-w-[44px]`, so every Button is a 44 px target on a coarse pointer. New sizes: `wrap` (a text decision that wraps a long translation: `h-auto min-h-8 … whitespace-normal`) and `inline` (a link inside running text: `h-auto p-0`, opts out of the touch minimum). |
| `ui/empty.tsx` | `size`: `default` (`gap-6 p-6 md:p-12`) and `compact` (`gap-4 p-4`); `variant`: `default` and `outline` (`border`). |
| `ui/card.tsx` | `size`: `default` (`gap-6 py-6`) and `compact` (`gap-0 py-0`, for a Card whose one child owns the insets). |
| `ui/item.tsx` | `size="compact"` (`gap-2.5 p-0`); an Item rendered as `a` or `button` is a 44 px target on a coarse pointer. |
| `ui/alert.tsx` | `variant="warning"` on the semantic warning tokens. |
| `ui/field.tsx` | `FieldLabel variant="option"`: the label of one choice in a set, at body weight. |
| `ui/popover.tsx` | Exports `PopoverAnchor`; `PopoverContent` carries the upstream classes instead of `kubecode-popover-content`, which no stylesheet styled. |
| `ui/command.tsx` | Exports `CommandLoading`; `CommandItem` is a 44 px target on a coarse pointer. |
| `ui/toggle.tsx` | 44 px target on a coarse pointer (ToggleGroup items inherit it). |
| `ui/attachment.tsx` | An Attachment with a trigger is a 44 px target on a coarse pointer. |
| `ui/sidebar.tsx` | `SidebarMenuSubButton size="lg"` (`h-12`), the touch row like `SidebarMenuButton`'s. Call sites pass `size` from `useSidebarMenuSize()` (`lg` on a coarse pointer). |
| `ai-elements/confirmation.tsx` | `ConfirmationAction` takes a Button `size` (default `sm`) instead of a fixed className, so a decision can take `wrap`. |

Removed from call sites, repo-wide: `pointer-coarse:min-h-*`,
`min-h-(--ws-touch-target)`, `max-sm:min-h-[44px]`, `.kubecode-touch-target`,
the `SidebarMenuAction` translate, `h-auto p-0` on link Buttons, `Empty
className="p-4|p-6|border"`, `Card className="py-0 gap-0"`, `Item
className="p-0"`, `FieldLabel className="font-normal"`.

### 3. Sonner

`pnpm dlx shadcn@latest add sonner` installed `src/components/ui/sonner.tsx`
with `sonner` 2.0.8 and `next-themes` 0.4.6 (new dependencies). The
Toaster takes the app's `appearance.colorScheme` as its `theme`, so it
follows `data-theme` rather than `next-themes`' provider.
`SystemMessageProvider` publishes through `toast()`: one host, the newest
three visible, a repeated message shown once (by id), warnings and errors kept
until closed, the close button and the region named from the locale. The
hand-made host (`.kubecode-system-message-host`) and the expand/collapse
notice are gone; the inline notices are official Alerts with a close Button;
the notification onboarding is a toast with its action and cancel.

### 4. Registry and catalogue

`components.json` names `@ai-elements` as
`https://elements.ai-sdk.dev/api/registry/{name}.json`, the host the legacy
`ai-sdk.dev/elements/api/registry` URL now redirects to. `shadcn view
@ai-elements/file-tree` and `add @ai-elements/terminal --dry-run` resolve
there (CLI 4.22.1). On 2026-10-24 that registry lists `file-tree`,
`model-selector`, `terminal`, `stack-trace`, `test-results` and `question`
besides the elements already installed; it does not list `subagent`, `chat`,
`questionnaire`, `trace` or `loader`.

The shadcn-hosted AI Elements (`ui.shadcn.com/docs/ai-elements/radix/<name>`:
Chain of Thought, Chat, Checkpoint, Confirmation, Context, File Tree, Inline
Citation, Message, Model Selector, Plan, Prompt Input, Queue, Reasoning,
Sources, Stack Trace, Subagent, Suggestion, Task, Terminal, Test Results,
Tool) are copy-paste patterns, not registry items. They are built on `trace`
and `code-block`, which the CLI publishes only for the new style families
(`radix-nova` and siblings), not for this project's `new-york` style
(`view @shadcn/trace` fails). A later slice that wants one copies the
pattern's source from its page (the "Manual" tab) and records it; `add` on
`@ai-elements/*` may offer to overwrite `ui/` files it depends on, so it is
run with `--dry-run` and never with `--overwrite`.

### 5. Retired wrappers and survivors

Retired, with their CSS: `StatusBadge` and `research/SourceBadge` (every
status is a `Badge`; the tone→variant map is `src/kubecode/statusTone.ts`),
`DecisionButton` and `attention/PromptDecision` (a `Button` or
`ConfirmationAction` in `size="wrap"`, busy with the official `Spinner` while
it keeps focus, its reason a `FieldDescription` it is described by),
`SendButton`/`StopButton`/`PauseButton` (send is `PromptInputSubmit`, a stop
is a `Button` with a `Tooltip` and a label that is visible on touch
(`pointer-fine:sr-only`), the round pause is the official `Toggle`),
`members/ConversationIdentity` (its HoverCard repeated the visible words),
`ui/action-tooltip.tsx` and `actionTooltipRecovery.ts` (`Tooltip` + `Kbd`),
`SystemMessageNotice` (Sonner and Alerts). The classes
`.kubecode-view-header-*`, `.kubecode-destination-header`'s paint,
`.kubecode-decision-*`, `.kubecode-icon-button`, `.kubecode-touch-target`,
`.kubecode-member-identity-*`, `.kubecode-identity-card*`,
`.kubecode-conversation-avatar`, `.kubecode-stop-button*`,
`.kubecode-send-button`, `.kubecode-pause-button`,
`.kubecode-system-message-host`, `.kubecode-reference-chip`,
`.kubecode-channel-header` and `.kubecode-task-next-step` are gone.

Survivors, each a pass-through with no CSS, kept because it carries a
contract that would otherwise be repeated at every call site:

| Component | Composition | Contract |
| --- | --- | --- |
| `IconButton` | `Button` icon size inside `Tooltip`, shortcut as `Kbd`, busy as `Spinner` | a required accessible name; busy keeps focus |
| `MemberIdentity` / `MemberAvatar` | `Item` with the `Avatar` as `ItemMedia`, the name as `ItemTitle` (a link `Button size="inline"` when it opens the profile), handle, role, attention `Badge`, activity and details as `ItemDescription` | avatar hidden from assistive technology; membership never shown as activity |
| `ViewHeader` / `DestinationHeader` | `Item` with `ItemHeader` (Back, glyph as `ItemMedia`, heading in `ItemTitle`, `ItemActions`, Close), facts as `ItemContent`, description as `ItemDescription`; the destination adds the official `Separator`. The `header` element only takes its context's padding. | heading level; Back/Close semantics shared by the shell, the inspector and the destinations (slices C–K) |
| `ReaderLoading` / `ReaderEmpty` / `ReaderNotice` | `Empty size="compact"` (the `Spinner` as `EmptyMedia`) and `Alert` | one role per reader state |
| `MoreActions`, `ReferenceChip` | unchanged compositions over `DropdownMenu` + `IconButton` and `Attachment` | one labelled overflow menu; a reference that only opens |

The audit's header font (16 px, 600) becomes the official `ItemTitle` scale
(14 px, 500) and the research decisions take the Button `wrap` size; as in
ADR 0247 §3, that is the intended scale, not a regression.

### 6. The CSS ownership check

`scripts/check-css-ownership.mjs` (run by `pnpm lint`, tested by
`scripts/check-css-ownership.test.mjs`) now also flags:

- `appearance-on-official`: a size, padding, border, radius, font or colour
  declaration in a rule whose subject is a class that TSX passes as
  `className` to an import from `src/components/ui` or
  `src/components/ai-elements` (resolved through `@/` and relative imports;
  `min-height: 0` and `height: 100%` count as layout);
- `element-reach-in`: a rule that reaches an element (`button`, `input`,
  `svg`, `a`, headings, …) or `[role=…]` through a combinator;
- `third-party-internal`: `.cm-`, `.xterm`, `[data-streamdown]`, `.hljs-`,
  `.katex`;
- `dead-class` and `dead-rule`: a `kubecode-*` class a TSX `className` uses
  that no stylesheet styles, and a rule whose `kubecode-*` class no product
  source mentions.

`scripts/css-ownership-baseline.json` was regenerated: 187 entries
(7 official-internal, 22 third-party-internal, 50 element-reach-in,
2 important, 56 appearance-on-official, 50 dead-class), the ten #254
exceptions keeping their owners and the rest marked for later slices. The
list only shrinks; every later slice removes its entries.

## Consequences

- Every Button, Toggle, interactive Item, CommandItem and Attachment is a
  44 px target on a coarse pointer by default; rows that are Buttons by
  accident (file tree, terminal navigator) grow on touch until their slice
  moves them to a list part.
- Two new dependencies (`sonner`, `next-themes`).
- Statuses, decisions, identities and headers take the official scale and
  tones; screenshots change where the wrappers painted their own.
- `git worktree` checkouts need their own `node_modules`: the CLI's `pnpm
  add` refuses a virtual store symlinked from another checkout.
