---
type: ADR
id: "0215"
title: "Workspace-owned research work, fenced coordination, and one Kanban projection"
status: proposed
date: 2026-10-19
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
- **Dependencies** decide *eligibility* (a planned item whose dependencies are
  all accepted becomes `ready`); authorization and capacity still gate
  *dispatch* and are checked by the server at the moment of dispatch, never
  implied by readiness.

Work may exist as a candidate before any RQ or round (no `round_id`). Research
execution requires an approved round: starting an attempt on an item without
one is refused. Legacy work that was never linked to a round stays unlinked; no
approval is invented.

### 3. Attempts, assignments, and results are separate records

- An **attempt** is one execution try of a task by an executing Session, with
  its run, status, and failure kind. Retries are new attempts of the same task.
- An **assignment** records which Session (and optional Team member) currently
  executes the task. A task can acquire a new executing Session: the previous
  open assignment is closed with a reason and a new one opened; the task id and
  every earlier attempt are untouched.
- A **result reference** attaches an existing record (experiment, artifact,
  finding, Session turn, file, ...) to a task or one of its attempts as
  `{kind, id, revision?}` — the reference model of ADR 0214. Nothing is copied.

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
mutating commands on them so two authorities never disagree. Deleting or
disbanding a Team removes its legacy rows but never its work items. Active
Teams therefore finish unchanged, and new work created natively is owned by the
work store from the start.

### 6. One projection for every consumer

`WorkSummary` — the item, its open assignment, its latest attempt, attempt
count, and result references — is the single shape the board, inspectors, and
evidence views consume. RQ, round, channel, Team, and Agent views are filters
over the same items; no consumer defines another task state model.

## Consequences

Two stores describe tasks during the transition, but only one writes each task:
the Team store for legacy items, the work store for native ones. The mirror is
eventually consistent only inside one transaction boundary (queue entry in the
same transaction as the legacy write; applied before the next work read), so a
reader never observes a stale mirror. Removing the legacy write path is left to
a later decision once no active Team uses it.

Non-goals: a provider, a cluster scheduler, multi-user messaging, a second
permission hierarchy, and frontend automation. Readiness, dispatch, and
authority are server decisions.
