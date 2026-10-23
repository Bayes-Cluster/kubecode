---
type: ADR
id: "0253"
title: "Session and Team execution views on official components"
status: accepted
date: 2026-10-23
---

## Context

Issue #261 (UI G, under #254) owns the technical Session and Team views: the
coding Session (timeline, composer, title bar, empty state), the Team control
centre, setup, tasks and verification, the Agent control menu, slash command
suggestions, side questions, and the work board's filters, columns and forms
taken over from UI E. ADR 0245 put the transcript itself on AI Elements, but
the surrounding controls were still handcrafted:

- the Agent control was a portal with fixed positioning, its own outside-click
  and Escape listeners, and `role="dialog"`/`role="menu"` sections of Buttons;
- slash command suggestions were a `listbox` of ghost Buttons;
- side questions, notices, the leader-review wait, the read-only banner, the
  revision switcher and the recreated-context divider were styled `div`s;
- the Chat/Team switch was a `tablist` of Buttons and the run status a
  coloured dot;
- Team setup used Button grids with `aria-pressed` for choices, the status
  view hand-drawn metrics and badges, the tasks dialog a `dl` and a second
  Dialog for confirmations;
- the work board filtered with native `select` and `checkbox` and pill
  `button`s, and the inspector's forms used native `select` and `input`;
- `kubecode.css` restyled official internals for these surfaces (22 baseline
  entries owned by #261, including four `!important` rules).

## Decision

1. **Menus and lists.** The Agent control is a `DropdownMenu`: a
   `DropdownMenuSub` with a `DropdownMenuRadioGroup` for the mode and for each
   native select option, a `DropdownMenuCheckboxItem` for each native boolean,
   and a disabled item titled with the lock reason when the mode cannot change.
   Only what the session's ACP state advertises is rendered, so the three
   Agents keep their different controls. Slash command suggestions are a
   `Command` list with `shouldFilter={false}`; the composer keeps focus and its
   key handling, and the list mirrors the selection through `value`.
2. **Notices and states.** `SystemMessageNotice` is an `Alert` (destructive for
   errors) with its expand and dismiss buttons; the leader-review wait and the
   read-only banner are Alerts; side questions are a `Collapsible` of Items.
3. **Session chrome.** The revision switcher is a `ButtonGroup`, a recreated
   context an AI Elements `Checkpoint`, the Chat/Team switch `Tabs`, the run
   status a `StatusBadge`, and the empty Session an `Empty` with an Item per
   Agent. The composer and history drop their inline styles; the reading
   column is a Tailwind layout class.
4. **Team views.** Setup uses `FieldGroup`/`Field`, `RadioGroup` choice cards
   for the mode, `ToggleGroup` for allowed Agents and an `Alert` for the YOLO
   warning; the leader's native options are Fields. The control centre uses
   `StatusBadge`, `Badge`, Items for metrics and needs-attention rows, and a
   Field for user input. Tasks use Items for activity and dependencies, a
   `StatusBadge` for the translated task status, and an `AlertDialog` for
   cancel and remove. The member strip and verification rounds are Items; the
   lineup proposal is a Card.
5. **Work board.** Filters are `Select`, `Checkbox` and a single-value
   `ToggleGroup` of attention conditions; column counts are Badges; the new
   Task form and the inspector's question, assignment, review, close and
   priority forms are Field, `Select`, `Input` and `Textarea`.
6. **New Session dialog.** `ToggleGroup` for new/import and Session/Team,
   `RadioGroup` choice cards for the execution workspace, Field for the rest,
   Items for importable provider sessions.
7. **CSS.** The #261 entries are removed from
   `scripts/css-ownership-baseline.json` with their rules; the remaining
   `kubecode-session-*`, `kubecode-team-*` and `kubecode-work-*` rules are
   layout only.

Components used that were not yet on `main` are taken byte-identical from the
slice branches that added them: `toggle-group.tsx` and `toggle.tsx` (UI D),
`radio-group.tsx`, `alert-dialog.tsx` and `checkbox.tsx` (UI E). No new
dependency is added.

### Registry discovery (2026-10-23)

`shadcn search @ai-elements` lists `terminal` and `stack-trace` components but
no Subagent component. Subagents stay on `Task`. Terminal needs the new
`ansi-to-react` dependency, and ACP tool output arrives as text without parsed
stack frames, so tool output stays in a Code Block. Adopting either is a
follow-up that needs its own ADR. `shadcn@4.22.1 add` and `info` also fail on
this repository's `components.json` ("Invalid configuration") in every
worktree, so no component was fetched with the CLI in this slice.

## Consequences

- Menus, tabs, collapsibles, dialogs and selects get Radix keyboard, focus and
  dismissal behaviour. The custom listeners and positioning code are removed.
- Tests open menus and selects the way Radix expects (keyboard on a trigger,
  `mouseDown` on a tab, a click on a combobox then on an option).
- The unused `AiPanelHeader`, `AiPanelContextBar`, `AiPermissionModeToggle`
  and `src/lib/aiAgentPermissionMode.ts` are deleted.
- Verification round status is translated
  (`kubecode.teamVerificationStatus.*` in every locale).
