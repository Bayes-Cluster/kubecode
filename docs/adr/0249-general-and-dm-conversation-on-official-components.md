---
type: ADR
id: "0249"
title: "General and DMs on the official conversation and composer components (UI C)"
status: accepted
date: 2026-10-23
---

## Context

Issue #257 (UI C, parent #254) moves General and DMs onto the official
components under the contract of [ADR 0247](0247-official-components-own-base-appearance.md).
Both already used AI Elements `Conversation`, `Message` and `PromptInput`
(ADR 0242), but around them sat handcrafted pieces: a `details` activity
group, `p` loading and error lines, a native checkbox fieldset and `select`
in the DM share dialog, an absolutely positioned `@mention` list, and
`kubecode.css` rules redrawing the Prompt Input card, the mention items and
the avatar fallbacks through `[data-slot=…]` and `[cmdk-item]` selectors.

## Decision

1. **Registry item added.** `checkbox` from `@shadcn` (new-york, Radix), added
   with `pnpm dlx shadcn@4.22.1 add checkbox`; it uses the existing
   `radix-ui@1.4.3` and `lucide-react`, so no new dependency. The CLI rejects
   the checked-in `components.json` while it names the built-in `@shadcn`
   registry, so the item was added with that key removed for the run and the
   file restored; the CLI also wrote `import { cn } from "cn"`, corrected to
   `@/lib/utils`.
2. **States are official components.** Load failures are `Alert`
   (destructive) with Retry inside; loading is `Spinner`; the DM share,
   "needs setup" and "not about this Task" notices are `Alert` with
   `role="status"`; a queued DM is a `Badge`.
3. **The DM share dialog** composes `FieldGroup`/`FieldSet`/`FieldLegend`,
   `Checkbox` + `FieldLabel` per turn, `Textarea` in a `Field`, `Select` for
   the Task (with a sentinel value for "No Task", since a Radix Select item
   cannot be empty), a `Card` preview, a `Collapsible` exact text and
   `DialogFooter`. Preview-before-confirm and the stale-digest refusal are
   unchanged.
4. **Activity groups** are a `Collapsible`. Their notes stay mounted while
   closed (`forceMount` + `hidden`) because links and citations land on them.
   A jump opens the group first through a DOM event (`revealActivity`,
   `channel/activityReveal.ts`) handled with `flushSync`, so the note is laid
   out before `scrollIntoView`. This is the smallest adapter: the list's jump
   only knows the target element, not which group holds it.
5. **The `@mention` list** is `PromptInputCommand` inside the official
   `Popover`, anchored to the composer with Radix `Popover.Anchor` (the
   installed `popover.tsx` predates the registry's `PopoverAnchor` export).
   Focus stays in the text box (`onOpenAutoFocus`/`onCloseAutoFocus`
   prevented); Escape or a press outside dismisses it until the researcher
   types on. The keyboard and IME contract of ADR 0222 is unchanged.
6. **Removed overrides.** The Prompt Input card background, radius, shadow and
   focus ring, the mention list and `[cmdk-item]` rules, the avatar fallback
   tones (except the researcher tone owned by #262), the activity group, date
   separator, legacy thread link, delivery line and proposal rules, and their
   baseline entries.

## Consequences

- The composer card, mention list and avatars look like the registry
  components in every theme; Workspace tone on avatars is gone except where
  another slice still owns a rule.
- Scrolling stays with `use-stick-to-bottom` through `Conversation`; the list
  keeps only its domain adapters (pagination anchoring, landing, reading
  position). Nothing else scrolls the thread.
- Remaining gaps are recorded in `docs/design/ui-migration-inventory.md`
  (thread pane, recipient line, citation button).
