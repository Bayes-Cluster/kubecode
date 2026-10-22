---
type: ADR
id: "0243"
title: "Official components for the Task inspector, Kanban and Needs you"
status: accepted
date: 2026-10-21
---

## Context

ADR 0241 installed the official shadcn/ui components and AI Elements and
moves product surfaces onto them one slice at a time. This is slice S2 of
#229: the Task inspector (`TaskPanel`, `TaskOverview`, `TaskWork`,
`TaskResults`), the Kanban board (`TaskBoardView`, `TaskCardView`), the
evidence panel (`EvidencePanel`) and the Needs you destination
(`NeedsYouView`, `NeedsYouList`). The product owner chose this direction. The
layout rules of ADRs 0239 and 0240, the 360-pixel inspector of ADR 0234, the
review's version binding (ADR 0230 §4) and the existing keyboard and focus
contracts stay.

## Decision

Each surface sets `data-ws-components="official"` (ADR 0241 §5), so the
official parts read the Workspace tokens in light and dark, and imports the
official files directly (`@/components/ui/*`, `@/components/ai-elements/*`),
never the `ai-elements` barrel or the ADR 0233 adaptations.

| Part | Built from |
| --- | --- |
| Task brief (question, hypotheses, criteria, constraints) | **Plan** (`Plan`, `PlanHeader`, `PlanContent`), always open; the brief's labels stay a description list inside `PlanContent` |
| Internal work and progress | **Task** / `TaskItem`, with **Badge** for stage and condition |
| Who waits for the researcher on a Task | **Task** / `TaskItem` with a `Button` to the one prompt that answers it |
| Status labels on these surfaces | **Badge** through `ToneBadge` (`src/kubecode/tasks/ToneBadge.tsx`), which keeps the `ok`/`info`/`warn`/`danger`/`muted` tones as `data-tone` on the official Badge |
| Decision group (accept or send back) | **Confirmation** in `approval-requested` state: `ConfirmationTitle` carries "Accepting takes the versions you were shown", `ConfirmationActions` holds the two `DecisionButton`s. The group keeps `role="group"` and its name, the disabled reasons stay accessible descriptions, and acceptance still binds to the displayed versions |
| Evidence list in a review and accepted evidence | **Sources** (always open, `SourcesContent`) with one **Item** per record; the reference chip, "Look at it" and "Accept the version shown" sit in `ItemContent` and `ItemActions` |
| Kanban card | **Card** around the one card button, which stays the only control |
| Stage picker on a narrow board | **Tabs** (`TabsList` named "Stage", one `TabsTrigger` per stage); each column is a force-mounted `TabsContent`, so a wide board still shows all four |
| Proposals and archived Tasks | **Collapsible** replacing `<details>`; proposals open while the board has no Task |
| Empty board | **Empty** with the Go to General action |
| Needs you groups and the manager's decisions | **ItemGroup** (a named list) of **Item** rows; each waiting row stays one button opening where it is answered |
| Needs you with nothing waiting | **Empty** |

Permission and input prompts are not restyled here: S1 owns
`PermissionPrompt` and `ElicitationPrompt`, and Needs you keeps opening them
where they live.

No string is added: every label comes from the existing catalog keys, and no
official default English string is rendered (`PlanTrigger` and
`SourcesTrigger` are not used).

### Unpublished or deferred

- No new dependency. Toggle Group (for the stage picker) is not installed;
  Tabs is the closer match because a narrow board shows one stage as a panel.
- `ResearchFindingsPanel`, `TaskActivity`, `TaskQuestions` and
  `RoundPauseControl` render unchanged inside the moved surfaces; they belong
  to the research and attention components and move with S5's cleanup or
  their own slice.
- Old `kubecode-task-*` and `kubecode-needs-you-*` rules that no longer match
  are left for S5's dead-CSS sweep.

## Consequences

- The board's stage picker is a tab list: smoke and unit tests address
  `tab` roles with `aria-selected` instead of pressed buttons.
- Proposals and archived Tasks report `data-state="open"` instead of the
  `open` property of `<details>`.
- The slice's layout additions live in one delimited block at the end of
  `kubecode.css`.
