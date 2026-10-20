---
type: ADR
id: "0230"
title: "Task-owned details, completion only through review, separate archiving, and evidence accepted at a displayed version"
status: proposed
date: 2026-10-20
supersedes: "0225 §3 (the Task inspector above a Task's full research workspace, with evidence opened inline); 0226 §3 only where a looked-at revision is required only for the review's own pins, and 0226 §4 (the revision recorded when 'Look at it' is clicked); 0212 §1 for admitted Tasks only (status changed directly by the researcher, and archiving as an unconditional command)"
---

## Context

Task details nested a whole research workspace. It showed a second state
(research Open/Resolved) beside the Task's stage, a "Mark resolved" that wrote
`research_questions.status` but no task event and so moved no stage, and an
unconditional Archive. The board lists only unarchived questions, so archiving a
Task under review silently removed it and its pending decision.

"Look at it" recorded the current revision before anything was read, so a
failed read enabled acceptance of changed evidence. The researcher's re-pin of
work-attached evidence treated the looked-at revision as optional, while the
re-pin of a review's own evidence required it.

The Task read model lacked the evidence a review cites with all of its pins,
the Task's history and the General messages that carried each step, what waits
on the researcher, and which actions are available, so the browser stitched
research endpoints together.

This ADR builds on ADR 0221 §3-§5 (admission and execution remain separate,
message-authorized steps), ADR 0223 §3 (a Task scope is a view of the one
General history), ADR 0226 §1-§2 (the manager's restriction and review routing,
unchanged), ADR 0227 (the shared controls) and ADR 0228 (the inspector stack,
the inspection record and place memory).

## Decision

### 1. One lifecycle

An admitted Task has one state, its derived stage (Ready, In progress, Review,
Done). Conditions, a changed brief, the required action, the accepted outcome
and Archived are badges, never states. Every stage read filters task events on
one list of stage event kinds.

Its research `status` mirrors the lifecycle (resolved on acceptance, open on
iteration) and is written only by the Task service:
`POST research/{id}/resolve|reopen` is refused for an admitted Task with
`409 task_owned`. Drafts and questions that are not Tasks keep ADR 0212.
Completing a Task is accepting its results in review; no form, button or drag
gesture changes a stage, admits or starts one.

### 2. Archiving is separate from accepting

`POST tasks/{id}/archive|restore` hides a Task (or a proposal) from the board,
or brings it back, keeping everything. Archiving is refused while a review is
open or the Task's internal work is active (`409 task_active` with `reason`
`under_review` or `work_active`); it is allowed for a proposal, a Ready or Done
Task, and an In-progress Task with no active work. The research archive route
applies the same rule; there is no bypass. The open-review check is repeated in
the archiving transaction, and a review request checks the archived flag in its
own, so neither can slip past the other.

On an admitted Task, archiving and restoring are recorded as `archived` and
`restored` task events, which are not stage events and never move the stage or
the authorization watermark. While archived, a Task refuses admission, revision
approval, execution, review requests and new internal work. The board lists
archived Tasks apart (`archived`: stage, accepted outcome), from where they can
be restored.

### 3. Task-owned details

A Task is an inspector entry with one header of Task facts, a next-step line,
and three sections: Overview (what waits on the researcher, goal, provenance,
people, progress), Results (the review, versioned evidence, the decision, the
outcome, findings, earlier reviews) and Activity (history linked to General,
recent Task-scoped messages, execution and linked records). Research readers
and editors are reused inside it, read only when a section needs them; the
research question view remains for questions that are not Tasks and, for a Task
(on the board or archived), shows the stage and links to it, with no resolve,
reopen, archive or round of its own. "Discuss in General" opens the one General
conversation filtered to the Task, at the open review's request message, with
the composer focused; it authorizes nothing. Going to General from a Task
keeps the Task beside General when both fit, and otherwise replaces it (never
under a Task General happened to remember). The section a Task opens on (Results
while a review is open, Overview otherwise) is decided once per opening, so a
decision does not move the researcher away from its result.

The board shows one lifecycle on every screen: proposals above the stages,
archived Tasks below them, cards that are one button with no control inside
(nothing is draggable), the required action, condition, changed brief and
outcome as badges, and, on a narrow board, one stage at a time that follows the
Task inspected last. Closing a Task returns focus to its card, found again by
its focus key when a decision moved it to another column.

### 4. Evidence is accepted only at a successfully displayed version

The server requires the looked-at revision on every researcher re-pin of a
Task's evidence, work-attached or review-cited, and refuses one that is no
longer current (`409 work_evidence_stale`). The revision the reads report (a
file read's content hash, a context read's reference revision) is the one the
acceptance check computes.

In the browser, the evidence reader reports a display only after it
rendered a successful read of the cited record itself, with that read's
revision; loading, a failed read, a removed record, a related record it moved
on to, or a later "load more" failure never count, and a later failure does not
revoke a display; a related record opens as its own entry over the evidence.
The record is per inspector stack and in memory only.
"Accept the version you saw" is enabled only while the displayed revision is
the current one, and re-pins every pin of that evidence at exactly it; a display
newer than the listed current version reloads the Task once. Evidence
with no revision, or that cannot be displayed, cannot have a change accepted;
the researcher sends the work back or, if it was removed, acknowledges that.

### 5. Decisions reach General

Accepting or sending back still records the review, routes it to the manager
(ADR 0226 §2) and posts the Task-linked verdict with the researcher's reason.
Review requests and verdicts expose their General message
(`general_message_id`), and the `POST review` response returns it. That lookup
is best effort: a decision already recorded is never reported as failed.

### 6. The read model carries what the surface needs, with no new tables

- card `last_event` (stage events only);
- draft `shown_message_id`, the newest General message that showed its current
  revision;
- one `evidence` row per cited `kind:id`, with every pin, the current revision,
  a status (`current`, `changed`, `removed`, `unpinned`), whether it is in the
  open review or was accepted, and a title for the rows the researcher must
  look at (at most 64 rows);
- a `timeline` of task events, approvals of revised briefs and brief revisions,
  each with the General message that carried it and, for authorized steps, the
  researcher's words (at most the newest 100);
- `pending` decisions with stable keys `review:{request}`,
  `question:{work}:{request}`, `brief:{revision}` and `evidence:{kind:id}`;
- `actions` (archive availability, restore) and `archived`;
- `internal_work` with the assigned Session and its last update.

Message ids come from batched lookups over the existing client-message-id
index. `stale_evidence` remains, deprecated. A resolved context reference
carries the record's `title`.

### 7. Place memory key

`placeKey.task(project, task) = "<project>|task:<task>"` is added for the
in-memory Task tab, review and answer drafts. No ADR 0228 key format changes,
and none of it is persisted.

## Consequences

- The researcher sees one state and one completion path; Mark resolved and
  Open/Resolved disappear from Tasks.
- An archive under review or mid-work fails with a reason instead of hiding
  the work. An In-progress Task with active work can only be stopped through
  the General Agent; a browser "abandon" would need its own authorization ADR.
- A researcher who could not read changed evidence can no longer accept it, and
  undisplayable evidence must be sent back.
- The work-path re-pin returns 400 without a revision; the review response
  gains a field; `stale_evidence` stays for older pages.
- The Task detail read is heavier: titles for at most 64 cited records, batched
  message lookups and a 100-step history.
- Known limits: the coordinator's `work_repin` tool and the Team work board's
  re-pin still pin without a researcher display (outside the Task review path);
  the inspection record is per stack, so opening the same Task from two places
  means looking twice; server-written General text stays English (ADR 0221).
