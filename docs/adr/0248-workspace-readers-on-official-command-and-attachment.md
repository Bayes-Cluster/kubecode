---
type: ADR
id: "0248"
title: "Workspace search, references and evidence readers on official Command, Attachment and Alert"
status: accepted
date: 2026-10-23
---

## Context

#258 (UI D, under #254) owns the Workspace search (Resources, the titlebar
launcher, Add context), version-aware references, and the one record reader
behind the inspector's resource preview and a Task's evidence. Before it:

- `WorkspaceSearch` drew its own combobox: an `Input` with handcrafted
  `role="combobox"`, `aria-activedescendant`, arrow/Home/End handling and a
  `ul role="listbox"` of `Item`s, redrawn by `.kubecode-ws-search-*` and
  `.kubecode-resource-row*` rules. ADR 0244 had deferred `Command` because
  cmdk filters and sorts on the client.
- Section filters were a loop of `Button`s with manual `aria-pressed`.
- Loading, empty, stale, failed and later-page-failed states were paragraphs
  styled by `.kubecode-research-muted/-error/-notice`.
- `ReferenceChip` was assembled from `Badge` and two `Button`s, coloured by
  `.kubecode-reference-chip-*` rules; `ReferenceSources` drew its own chevron
  and list.
- `RecordPreview` used `strong` + `StatusBadge` for its header and a bare
  list for related records; `.kubecode-record-code pre` overrode the Code
  Block with `!important`.

## Decision

1. **Search is the official `Command`.** cmdk 1.1.1 owns the combobox and
   listbox roles, the active row, `aria-activedescendant`, arrow keys, IME
   composition (it ignores `isComposing`/229) and scrolling the active row
   into view. Server ranking and paging are kept with
   `shouldFilter={false}` (no client filter and no client sort). The active
   row is the controlled `value`, so it survives in place memory. The
   adapter keeps only domain keys: Enter attaches in attach mode and waits
   for results; → previews in attach mode; Escape clears, then steps back;
   Home/End move the caret when words are typed (`stopPropagation` keeps
   them from cmdk). The previewed result is `aria-current`, not
   `aria-selected` (which cmdk reserves for the active row).
2. **Gap, with evidence:** cmdk updates `aria-activedescendant` only for a
   row it activated itself; a controlled `value` change does not
   (`selectedItemId` is set only in its internal `setState('value')`). When
   focus returns to a row after Back, the row dispatches a `pointermove` so
   cmdk activates it, then focus moves to the input. Covered by
   `WorkspaceSearch.test.tsx` ("a row that gets focus…").
3. **Section filters are `ToggleGroup type="multiple"`** (added with the
   shadcn CLI, Radix), with a `Badge` for counts.
4. **Reader states are shared** in `src/kubecode/resources/ReaderStates.tsx`:
   `ReaderLoading` (Spinner), `ReaderEmpty` (Empty), `ReaderNotice` (Alert;
   `failed` is destructive and `role="alert"`, otherwise `role="status"` or a
   standing note). Search, Add context, the resource panel, the record
   preview and evidence use them; C (#257) and E (#259) should use them for
   material and evidence states.
5. **A reference is the official `Attachment`** (`size="xs"`):
   `AttachmentMedia` holds the kind glyph, `AttachmentTitle` the name,
   `AttachmentDescription` the version and a `Badge` for the state
   (`warning` changed, `destructive` removed, `secondary` unavailable),
   `AttachmentTrigger` opens it (named by kind, title, version and state),
   `AttachmentAction` removes it from a draft. The domain state is
   `data-reference-state`; `data-state` is the Attachment's own. The
   `ReferenceChip` props are unchanged for every caller.
6. **Sources stay AI Elements `Sources`** with their own trigger and content.
   `Source` is an external link (`target="_blank"`); a Workspace reference
   opens in the inspector, so each source is a `ReferenceChip`. The backend
   records which objects a message cites but not where in the text, so
   `InlineCitation` is not used: no positions are fabricated.
7. **The record reader composes `Item`, `Badge`, `CodeBlock` and
   streamdown.** Related records are an `ItemGroup` of `Item` buttons with a
   `related:<kind>:<id>` focus key. The Streamdown hardening and the
   "markdown only for `.md` files" rule are unchanged.

## Consequences

- `.kubecode-ws-search-*`, `.kubecode-resource-row*`, `.kubecode-attach-bar`,
  `.kubecode-record-preview-*`, `.kubecode-record-code*`,
  `.kubecode-record-markdown*`, `.kubecode-add-context*`,
  `.kubecode-reference-chip*` and `.kubecode-reference-sources*` rules are
  gone, with their six CSS ownership baseline entries.
- Evidence acceptance is unchanged: only a version `RecordPreview` reports
  as displayed can be accepted.
- The marker classes `kubecode-reference-chip`, `-open` and `-remove` remain
  without CSS, for tests and the control matrix.
