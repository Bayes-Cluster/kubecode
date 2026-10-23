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

Discovery on 2026-10-23: the shadcn registry items at
`ui.shadcn.com/r/styles/new-york-v4/*.json` (CLI 4.22.1) and the AI Elements
registry at `elements.ai-sdk.dev/api/registry/<name>.json` (`file-tree`,
`terminal`, `code-block`), read for the features each kept surface needs.

| Kept | Official candidate checked | Gap found | Smallest adapter | Tests |
| --- | --- | --- | --- | --- |
| CodeMirror 6 (`CodeEditor`) | AI Elements `code-block` | renders Shiki-highlighted read-only output; no editing, change events or selection model | CodeMirror inside the official toolbar, unsaved `Badge`, `AlertDialog` close confirmation and save `Button` | `CodeEditor.test.tsx` "preserves the editor, scroll position, and DOM selection across controlled rerenders", "synchronizes externally replaced content without remounting the editor" |
| xterm (`TerminalView`) | AI Elements `terminal` | displays output text only; no input, PTY or resize protocol | xterm inside official split (`Resizable`), `Empty`, `Alert` and Restart `Button`; the `.xterm-viewport` background stays the ADR 0247 exception | `TerminalWorkspace.test.tsx` "restores a project split tree and its freely resized ratio", "restarts an exited terminal in its original Session workspace"; smoke `kubecode-workspace.spec.ts` |
| `ProjectFileTree` | AI Elements `file-tree` | a fully loaded nested tree of `Collapsible`s: no lazy per-directory loading, no virtualisation, no `aria-level` | flat virtualised row model (react-virtuoso) with ARIA tree keys; rows are ghost `Button`s, states are `Spinner`/`Alert`, the toggle is `IconButton` | `ProjectFileTree.test.tsx` "expanding a directory loads only that directory", "bounds mounted rows for a large cached directory", "exposes tree levels and keyboard navigation for the active row", "moves keyboard focus through virtual windows without changing row identity" |
| Git change rows | shadcn `item`, `table` | neither virtualises; a large status (thousands of rows) would mount every row | fixed 36 px rows virtualised above 200; each row is a `Button` plus stage, unstage and discard `IconButton`s; group headers use `Badge` | `ContextWorkbench.test.tsx` "bounds mounted rows independently for large Conflict, Staged, and Changes groups", "shows Git changes in Explorer and stages a file" |
| Diff text | AI Elements `code-block` | Shiki re-tokenizes the whole diff on every render | a `pre`; the server bounds the diff size; loading, unavailable and failed states are `Empty`/`Spinner`/`Alert` | `useGitDiff.test.ts` (request fencing, failure, abort); `ContextWorkbench.test.tsx` "loads untracked diffs from GitService and renders explicit unavailable reasons" |
| Terminal list rows | shadcn `sidebar` (`SidebarMenu`) | a list: no `role="tree"`, no `aria-level`, no sortable model | dnd-kit sortable split groups (unchanged from main) with inline rename; rows are `Button`s, rename is `Input`, the profile menu is `DropdownMenu`, the width is a collapsible `ResizablePanel` | `TerminalWorkspace.test.tsx` "renames a terminal from the side navigator", "collapses and restores the resizable terminal navigator"; the drag order code is unchanged from main and has no new test |
| Research log, import text and process output | — | plain preformatted text | `pre` / text blocks inside official containers | research panel tests under `src/kubecode/research/` |

None of these exempts a generic control: every button, menu, notice,
confirmation, field and splitter around them is an official component.

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

`.kubecode-research-workspace` keeps its padding, background and native
`overflow-y: auto`. The official `ScrollArea` puts content in a Radix viewport
child with `display: table; min-width: 100%`, which lets unbreakable research
text widen the pane at 320 px (the containment the research smoke specs
check); using it would need an override of that official internal, which ADR
0247 forbids. The `kubecode-research-muted`, `-error` and `-notice` helpers
stay because about 25 components outside this issue still use them; they move
with those components' owners.

## Consequences

Every reachable file, Git, terminal and research surface takes its controls,
feedback, confirmation and resizing from official components, with keyboard
and touch resizing for the terminal for the first time. The
`.kubecode-conversation-avatar[data-role='researcher']` baseline entry stays
with the conversation identity block that #257 reworks; the terminal
`.xterm-viewport` `!important` stays as the ADR 0247 exception. `PathPicker`
moves to `Command` here as a byte-identical copy of the #260 branch's file
(and its test), so quick open and the new-entry dialog are on `Command`
whichever branch lands first; its leftover picker CSS stays with #260.

The Enter shortcut on the commit message ignores key repeat and is ignored
while a commit is in flight; the commit button is disabled for that time.

## Evidence

Captured with the smoke server against the real routes before (origin/main)
and after this branch, kept outside the repository with the issue report:
the Files and Git workbench and the research brief at 1440, 768, 390 and
320 px in light and dark, de-DE long copy, research discussion and work tabs,
touch at 320 px, keyboard split focus, 200% zoom with reduced motion.

| Measure (same machine, smoke server) | Before | After |
| --- | --- | --- |
| Expand a large file tree directory (ms) | 743 | 574 |
| Write 200,000 terminal lines (ms) | 2383 | 1023 |
| Keyboard steps to move a split by 10% | none (mouse only) | arrow keys on the `ResizableHandle` |

Resizing, collapsing the terminal list and switching tabs do not remount
`TerminalView` or `CodeEditor` (the tests named in §3), and large trees, Git
statuses and diffs keep their bounded rendering.
