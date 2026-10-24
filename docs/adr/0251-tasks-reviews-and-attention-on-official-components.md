---
type: ADR
id: "0251"
title: "Tasks, reviews, Needs you and execution feedback on official components"
status: accepted
date: 2026-10-23
---

## Context

Issue #259 (UI E, under #254) owns the Kanban, the Task inspector (Overview,
Results, Activity), the review decision, Needs you, the permission and input
prompts and the execution strip. After ADR 0243 and ADR 0247 these surfaces
still mixed official parts with handcrafted structure: `p role="alert"` error
lines, muted loading paragraphs, native `details`, a native checkbox and radio
fieldset in the review, `ul/li` rows with spans, a hand-drawn card and
next-step strip, and about 330 lines of `kubecode.css` (ten of them listed in
`scripts/css-ownership-baseline.json`) that redrew Card, Item, Alert, Empty,
Tabs, Plan, Queue and Field.

## Decision

### 1. Official compositions per surface

| Surface | Composition |
| --- | --- |
| Kanban card | `Card` holding the card's one button (no control inside it, so nothing drags, admits or starts a Task) |
| Proposals, archived Tasks, Needs you rows, recent General messages | `Item asChild` on the row's own `button` (`ItemContent`/`ItemTitle`/`ItemDescription`/`ItemActions`) |
| Folded lists and record sections | `Collapsible` with a ghost `Button` trigger (`TaskDisclosure`) |
| Board filter | `Field` horizontal + `Switch` + `FieldLabel` |
| Next step, decided note | `Alert` |
| Load, refresh and decision failures | `Alert` destructive (`ReaderNotice failed`) |
| Loading, nothing yet | `Spinner` status line and `Empty` (`ReaderLoading`, `ReaderEmpty`) |
| Archive confirm / blocked | `AlertDialog` |
| Open review | `Card` (header, content, footer) with `Checkbox` + `Field` for the removed-evidence acknowledgement, `FieldSet` + `RadioGroup` for the outcome, `Field` + `Textarea` + `FieldDescription` for the feedback, and the AI Elements `Confirmation` for the decision |
| Earlier reviews, waiting items, questions, activity steps, delivery issues | `Item` in an `ItemGroup` or ordered list |
| Prompt outcomes | `PromptOutcome`: a status line, or `Alert` destructive when an answer was not recorded |
| Failed turn in the strip | `Alert` destructive with Open member and Dismiss |
| Running list | `Popover` + AI Elements `Queue`; a lone row is an outline `Item` |

The reader states come from #258's `src/kubecode/resources/ReaderStates.tsx`
(added here byte-identical so both slices merge cleanly) rather than a second
copy. `ReferenceChip` keeps the #258 interface.

### 2. Registry items

Added with `pnpm dlx shadcn@4.22.1 add checkbox radio-group alert-dialog`
(`@shadcn`, new-york, Radix); the CLI's `cn` import was pointed at
`@/lib/utils`. `checkbox.tsx` and `alert-dialog.tsx` are byte-identical to the
copies on the #257 and #260 branches. No new npm dependency: the primitives
come from the existing `radix-ui` package.

### 3. Behaviour kept

Stage remains a Task's only state; the board offers no drag or stage change.
Accept still requires an outcome, an acknowledgement for removed evidence and
the displayed version of changed evidence; send back still requires feedback;
a decision is resolved once through the attention context so Needs you, the
bell and the panel agree. Archive asks first and the dialog stays until the
server answers. Stop names its Task or reply and pauses only that Task's round
(ADR 0238/0240); "Pause new work" stays the round's own pressed control.
Permission prompts keep 1–9 selection and the focus hand-off.

### 4. CSS

Every `kubecode.css` rule that styled these surfaces is removed with its
baseline entries. One layout block remains: the board's container queries
(four, two, one column and the phone stage picker), the sticky review decision
on a phone screen, the Needs you view's scroll container and the capped prompt
body on small screens. Touch targets for `xs` buttons use
`pointer-coarse:min-h-[44px]` on the button.

## Consequences

The Task, attention and execution views no longer depend on page-level CSS
for appearance, and the review is one Card with official form controls.
`SessionComposer`'s leader-review block (#261) still uses the
`.kubecode-permission-dock`/`-heading` rules, which are left for #261.
`WorkBoard`/`WorkInspector` (Team tasks, #261) take the shared reader states;
their filters, columns and forms stay with #261.
