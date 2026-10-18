---
type: ADR
id: "0215"
title: "Workspace-owned research work, fenced coordination, and one Kanban projection"
status: proposed
date: 2026-10-18
supersedes: "0177 and 0186 where they make the Team and its fixed Leader the owner of research tasks and authority"
---

## Context

Research execution today lives inside a Team: tasks, attempts, and results are
rows of that Team (`team_tasks`, `team_task_attempts`), authority belongs to a
fixed Leader (ADR 0177, ADR 0186), and a board would be a view of one Team. A
Team can be disbanded, a Session removed, or a Leader's context lost, and the
work goes with it. The blueprint in #185 wants the opposite: the researcher
converses in the Workspace, agents organize execution, and tasks, attempts,
evidence, and decisions outlive whichever Sessions executed them, shown on
exactly one board.

This decision defines the durable contracts the rest of the milestone consumes.
It changes ownership, not the Team runtime: ACP Sessions, the MCP transport and
caller isolation, the durable mailbox, experiment running, and ProjectContext
are reused unchanged. ADR 0177 and ADR 0186 remain accepted for ordinary Teams;
for *research work* this ADR supersedes their rule that the Team (and its fixed
Leader) owns the tasks and holds the authority.

## Decision

### 1. A Workspace is a Project

There is no new tenancy level. Every record below carries `project_id`; a
record, round, Session, or dependency from another Project is indistinguishable
from a missing one. Unregistering a Project still only unregisters it.

### 2. A work item is the canonical task

`work_items` (module `work_store`) owns one task for its whole life. It is
independent of any Team and any Session:

- **Identity** — a stable id, the owning Project, an optional `research_id` and
  `round_id`, and a `team_id` kept only as attribution of legacy work.
- **Facets that never share a field**:
  - `stage`: `planned`, `ready`, `executing`, `analyzing`, `review`, `done`.
  - `condition`: `none`, `waiting`, `blocked`, `paused`, `needs_input`, with a
    reason. A condition is explicit and orthogonal to stage.
  - `lifecycle`: `active`, `canceled`, `abandoned`, `superseded`, with the
    reason and, for supersession, the replacing item. Closed work keeps its
    stage, attempts, and results.
  - `acceptance`: `pending`, `accepted`, `rejected` — the review decision.
  - `outcome`: `unknown`, `supported`, `refuted`, `inconclusive` — the
    scientific result. A valid negative result (`refuted`) can be an *accepted*
    task; a process that exited zero is not an accepted task; an accepted task
    is not a resolved question.
- **Revision** — an integer bumped by every plan or dependency change. Updates
  carry `expected_revision`; a stale one is refused with the current revision.
  A separate **state revision** is bumped by *every* change to the item (a
  database trigger, so no code path can forget); a command may carry the state
  revision its caller looked at and is refused with `stale_state` if the item
  moved on, so a stale card can never act on newer state.
- **Dependencies** decide *eligibility* (a planned item whose dependencies are
  all accepted becomes `ready`); authorization and capacity still gate
  *dispatch* and are checked by the server at the moment of dispatch, never
  implied by readiness.

Work may exist as a candidate before any RQ or round (no `round_id`). Research
execution requires an approved round: a round exists only after the researcher
requested it against a pinned brief revision, and starting an attempt is
refused when the item has no round or the round's question is archived or
resolved. Legacy work that was never linked to a round stays unlinked; no
approval is invented. A plan may be put up for review before any attempt
(`review_kind = plan`); accepting it makes the work `ready`, which is not an
accepted result.

Each review decision is a record of its own — kind, accept or reject, outcome,
reviewer, reason, and the attempts and result references it looked at — so
what was reviewed stays answerable after the work changes. Creation and
dispatch take client request keys: repeating one returns the original task or
attempt instead of making another.

### 3. Attempts, assignments, and results are separate records

- An **attempt** is one execution try of a task by an executing Session, with
  its run, status, and failure kind. Retries are new attempts of the same task.
- An **assignment** records which Session (and optional Team member) currently
  executes the task. A task can acquire a new executing Session: the previous
  open assignment is closed with a reason and a new one opened; the task id and
  every earlier attempt are untouched.
- A **result reference** attaches an existing record (experiment, artifact,
  finding, Session turn, file, ...) to a task or one of its attempts as
  `{kind, id, revision?}` — the reference model of ADR 0214. Nothing is copied,
  and a reference is accepted only if the record exists in the same Project
  (another Project's record reads exactly like a missing one).

### 4. One effective, fenced coordinator per round

`round_coordinators` holds the Session currently coordinating a round and an
`epoch`. A handoff names the epoch it expects and increments it; every
coordinator-gated command presents `(holder, epoch)` and is refused with
`stale_coordinator` unless both match the persisted row *now*. A handoff
retains tasks, attempts, and waits (they never belonged to the coordinator) and
revokes the old holder's authority at every boundary because authority is
re-read from the row, not from a role prompt or cached state. The researcher is
always an authorized actor for their own Project. Cross-Project and cross-round
use of an authorization is refused.

### 5. Legacy Team tasks migrate additively and stay operable

Existing `team_tasks`, `team_task_attempts`, and their dependencies are
mirrored into work items **with the same ids**, so every existing reference
(mailbox messages, experiments, findings) stays valid. The mirror is
database-driven and resumable: triggers on the legacy tables enqueue the owning
Team in `work_sync_queue`, and a reconcile step (run at startup and before any
work read or write) upserts the Team's items, attempts, dependencies, assignment,
round attribution, and — for a research Team — the Leader as that round's first
coordinator. Reconcile is idempotent and re-runnable after a crash.

Legacy items keep their origin (`legacy_team`). Their state is mirrored from the
Team store, which remains the only writer for them; the work store refuses
mutating commands on them so two authorities never disagree. Legacy statuses
map onto the facets without inventing state: `pending`/`blocked` are
dependency eligibility (`ready` or `planned`), `changes_requested` is a
rejected review back in execution, `failed` is an execution stage needing a
decision (a failed attempt is history, not an end), and a cancelled task keeps
the stage it was cancelled in. An open experiment wait for the task, and the
task's experiments as evidence references, are mirrored too.

Deleting a Team mirrors its last changes and *re-owns* its work in the same
transaction: items become native (operable through the work store), runs that
can no longer report are cancelled, a submitted result is kept as completed
work, the old assignments end, and the Team's experiments are detached from
the Team (they are the work's evidence and must not cascade away with it). The Team's rows then cascade away; the work
items, attempts, assignments, results, and coordinator history stay. Active
Teams therefore finish unchanged, and new work created natively is owned by the
work store from the start.

### 6. One projection for every consumer

`WorkSummary` — the item, its open assignment, its latest attempt, attempt
count, result references, per-dependency state, superseded items, experiment
count, and last activity — is the single shape the board, inspectors, and
evidence views consume. RQ, round, channel, Team, and Agent views are filters
over the same items; no consumer defines another task state model.

## Consequences

Two stores describe tasks during the transition, but only one writes each task:
the Team store for legacy items, the work store for native ones. The mirror
lags a legacy write only by its queue entry, which is committed in the same
transaction and applied before the next read or write through the work store,
so a reader of the work store never observes a stale mirror (a crash in
between is repaired by the startup drain). Removing the legacy write path is left to
a later decision once no active Team uses it.

Known limits accepted for now: a removed Session is not cleaned out of old
assignments or coordinator rows (the researcher recovers with a handoff or a
reassignment), a Team whose mirror fails blocks the queue until fixed, and
readiness is recomputed per Project on each write. Each is revisited when the
board and orchestration children measure them.

Deferred to later children of #185 and added to this ADR when they land: using
native tasks in experiment launches and waits (today they validate against
Team tasks), the dispatch gate with capacity and budget, coordinator routing
and message delivery, the board's grouping and inspector commands, and
analysis and evidence review beyond the review record above.

Non-goals: a provider, a cluster scheduler, multi-user messaging, a second
permission hierarchy, and frontend automation. Readiness, dispatch, and
authority are server decisions.
