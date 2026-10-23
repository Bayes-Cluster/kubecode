---
type: ADR
id: "0252"
title: "File, Git, terminal and research utilities on official components"
status: accepted
date: 2026-10-23
---

## Context

Issue #262 (UI H, under #254) owns the tools beyond the everyday views: the
Files and Git panel (`ContextWorkbench`, `ProjectFileTree`, `GitDiffView`,
the editor around `CodeEditor`), the terminal dock (`TerminalWorkspace`
around `TerminalView`), the application message notice
(`SystemMessageNotice`), the Team deletion confirmation, every research view
under `src/kubecode/research/`, and the read-only earlier-thread pane taken
over from #257. ADR 0247 says official components own structure, behaviour
and base appearance; ADR 0248 added Resizable for the shell and left the
terminal split on the hand-written `ResizeHandle`.

Before this change these surfaces still drew their own generic UI:

- the terminal split and the terminal list were sized by `ResizeHandle`
  (mouse only, no keyboard or touch, no separator semantics);
- Explorer sections were hand-made toggles; empty and notice states were
  styled `div`s; the commit box was a loose `Input` and `Button`; the discard
  and unsaved-close confirmations were plain `Dialog`s; icon buttons had no
  tooltip; `kubecode.css` redrew the official `TabsTrigger`;
- the diff view's loading, unavailable and failed states, the file tree's
  loading and error lines, the terminal's empty and exited states and the
  application message strip were styled `div`s;
- the research views used native checkboxes (with an `!important` row
  override), `label > span` form rows, `p role="alert"` errors, a warning
  `p` for notices, hand-made cards and lists, a raw `button` link, and an
  inline `role="alertdialog"` with manual focus for cancelling a round's
  processes;
- the earlier-thread pane chose its research link with native `select`s.

## Decision

### 1. Official compositions per surface

| Surface | Composition |
| --- | --- |
| Terminal split tree | `ResizablePanelGroup` per split (orientation from the split), two `ResizablePanel`s, a named `ResizableHandle`; the stored ratio is the group's `defaultLayout` and `onLayoutChanged` writes it back; double-click resets to 50% |
| Terminal list width | `ResizablePanel` (`collapsible`, `collapsedSize` 46 px, `minSize` 80 px, `maxSize` 500 px, `preserve-pixel-size`) beside the canvas; the toolbar toggle and a double-click collapse or expand it through the panel ref |
| Terminal empty / exited | `Empty` (+ `Spinner` while creating) / `Alert` with the Restart `Button` |
| Files and Git tabs | official `Tabs` with `TabsList variant="line"`; the tab-bar redraw is gone |
| Toolbar and row icon actions | `IconButton` (Button + Tooltip) |
| Explorer sections | `Collapsible` with a ghost `Button` trigger and a `Badge` count |
| No repository / no changes | `Empty` (with the create action in `EmptyContent`) |
| Truncated status, conflict hint | `Alert role="status"` |
| Commit message | `InputGroup` + `InputGroupInput` + `InputGroupButton`; Enter commits unless an IME is composing |
| Agent plan in Explorer | `ItemGroup` of `Item`s with the plan status icon |
| Discard changes, close an unsaved file, delete a Team | `AlertDialog` (the Team dialog stays open, with Cancel disabled, until the server answers) |
| Editor toolbar | path text, `Badge variant="warning"` for unsaved, `Button`, `IconButton` |
| Diff states | `Empty`/`Spinner` (loading), `Empty` (unavailable), `Alert` destructive with Retry (failed) |
| File tree states, excluded-files toggle | `Spinner` line, `Alert role="status"`, `IconButton` (tree) / `Toggle` (quick open) |
| Application messages | `Alert` (destructive for errors) with a level icon, `AlertTitle` for the source, and `IconButton`s for details and dismiss |
| Research forms | `FieldGroup`/`Field`/`FieldLabel`/`FieldDescription`/`FieldError`; `FieldSet` + `FieldLegend` + `Checkbox` for carried sources, cited imports, import candidates and export sections |
| Research lists | `ItemGroup` + `Item` (sessions, log entries, linked threads, proposals, pending outcomes, findings, rounds, imports, experiments) |
| Research notices and errors | `Alert` (status / destructive); the pending-decisions link is a `Button variant="link"` |
| Research loading and failed loads | `ReaderLoading` / `ReaderNotice` from #258's `ReaderStates.tsx` (byte-identical copy) |
| Round's execution details | `Collapsible` (trigger in the round row) |
| Brief comparison before applying an import | `Table` |
| Cancel every process of a round | `AlertDialog`; the confirm button stays until the server accepts |
| Earlier thread's research and round | `Select` + `SelectGroup` (the whole-question choice has a non-empty value, as Radix requires) |

`ResearchLayout.tsx` keeps only the panel column (`flex` + `gap` +
`max-width`) and the section heading; it owns no appearance beyond spacing
and the label, and is not a second card or list component.

### 2. Registry items

Added with `pnpm dlx shadcn@4.22.1 add alert-dialog checkbox table`
(`@shadcn`, new-york, Radix). The CLI rejects `components.json` while it
names the built-in `@shadcn` registry, so the entry was removed for the
command and restored unchanged. The CLI's `cn` import was pointed at
`@/lib/utils`. `alert-dialog.tsx` and `checkbox.tsx` are byte-identical to the
copies on the #259 and #260 branches; `table.tsx` is new. No npm dependency
is added: the primitives come from the existing `radix-ui` package and the
`react-resizable-panels` dependency recorded in ADR 0248.

### 3. Specialist engines and domain adapters kept

| Kept | Why | Not exempted |
| --- | --- | --- |
| CodeMirror 6 (`CodeEditor`) | editable code with language modes; AI Elements `CodeBlock` is read-only | the toolbar, unsaved state, close confirmation and save are official components |
| xterm (`TerminalView`) | an interactive PTY; AI Elements `Terminal` is output only | split, list width, empty, exited and error states are official components; the `.xterm-viewport` background stays the ADR 0247 exception |
| `ProjectFileTree` | lazy, per-directory loading, file-change invalidation and virtualised rows (react-virtuoso) for large trees, with ARIA tree keyboard navigation over the flat row model. The AI Elements File Tree renders a fully loaded nested tree of `Collapsible`s with no lazy loading or virtualisation | its states and toggle are official; rows are ghost `Button`s |
| Git change rows | virtualised above 200 rows with a fixed 36 px height; each row is a `Button` (open diff) and `IconButton`s (stage, unstage, discard) | group headers use `Badge`; notices and empty states are official |
| Diff text | a `pre`: the server bounds its size, and a highlighter would re-tokenize the whole diff | every state around it is official |
| Terminal list rows | an ARIA tree of split groups with drag reordering (dnd-kit) and inline rename; `SidebarMenu` is a list without tree semantics or a sortable model | rows are `Button`s, rename is `Input`, the profile menu is `DropdownMenu` |
| Research log, import text and process output | `pre` / text blocks inside official containers | — |

### 4. Behaviour kept

Discard and close still ask first and never run without confirmation; the
Team dialog cannot be dismissed while deleting. Terminal panes keep their
identity and PTY across resizes, theme changes and collapse (panels resize;
`TerminalView` is never remounted), and an unsaved editor draft survives tab
switches and layout changes. A round's execution details mount only while
open, as before. The research views keep their revision checks, idempotency
keys, ACP-agent choices and archived read-only rules; no control is added for
a capability the server lacks. Project and Session removal boundaries and the
generic base path are untouched.

### 5. CSS

Removed from `kubecode.css` with their baseline entries: the context tab-bar
and its two `TabsTrigger` overrides (four entries), the editor toolbar,
review empty, Git notice, commit box, diff message, plan list, dirty dot and
section trigger rules; the terminal split rules; the application message
strip; the file tree empty line; and every research layout rule, including
the two `!important` declarations on `.kubecode-research-check` and the
`select-trigger` override. What remains is container layout (`position`,
`grid`, `flex`, `overflow`) for the terminal dock, the Explorer sections and
the floating notices.

## Consequences

Every reachable file, Git, terminal and research surface takes its controls,
feedback, confirmation and resizing from official components, with keyboard
and touch resizing for the terminal for the first time. The
`.kubecode-conversation-avatar[data-role='researcher']` baseline entry stays
with the conversation identity block that #257 reworks; the terminal
`.xterm-viewport` `!important` stays as the ADR 0247 exception. `PathPicker`'s
move to `Command` is #260's; `ProjectFilePicker` and the new-entry dialog
consume it unchanged.
