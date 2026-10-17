---
type: ADR
id: "0212"
title: "Project-scoped research questions, versioned briefs, and execution continuity"
status: proposed
date: 2026-10-17
---

## Context

Kubecode Projects, Sessions, and Teams model *work*, not the research that
motivates it. A researcher who discusses a question, runs a Team, and then
wants a second round must today reconstruct the question, constraints, and
what was learned by copying text between Sessions. Issue #147 sketches a
Research Workspace; issue #148 scopes the first milestone: make a research
question (RQ) the durable home for discussion, execution context, and
findings while reusing the existing Session and Team runtime.

This ADR defines the new abstraction. It reuses ADR 0200 (single-owner
SQLite), ADR 0205 (durable workspace events), ADR 0206 (typed Composer
context), and ADR 0210 (run admission and queue), and it changes none of them.
Team authority (ADR 0177, 0183, 0186) is unchanged: a Leader still owns task
decomposition, scheduling, review, and completion.

## Decision

### 1. An RQ is a Project-scoped record, not an execution

A **research question** belongs to exactly one registered Project and is
addressed by `(project_id, research_id)`; every lookup is scoped by Project, so
another Project's RQ is indistinguishable from a missing one. Saving, editing,
discussing, or linking an RQ never starts an Agent. Execution happens only
through the explicit actions in §6, and completing a Team never resolves an RQ.

An RQ has two orthogonal pieces of state:

- `status`: `open` or `resolved`. Only the researcher changes it.
- `archived`: a reversible flag. Archiving hides the RQ from the default list
  and blocks further writes; it deletes nothing.

### 2. The research brief is versioned and researcher-approved

The **brief** is the approved direction: `title`, `question`, `motivation`,
`hypotheses[]`, `constraints[]`, and `evaluation_criteria[]`. It is bounded
(16 KiB serialized; at most 20 items per list, each at most 1,000 characters).

- The RQ carries a monotonic integer `revision` (starting at 1) that increases
  only when the brief content changes.
- Every revision is stored as an **immutable row** and is never pruned or
  rewritten. Downstream records (execution rounds, findings) cite a revision
  number, so retention must be unconditional. Sizes are bounded per revision
  instead of count-limited.
- Brief edits require `expected_revision`; a mismatch returns a conflict that
  names the current revision and writes nothing. An edit that changes nothing
  creates no revision.
- `status` and `archived` transitions are idempotent commands (setting the
  state the RQ already has succeeds without effect), so they need no revision
  check and never create a brief revision.

Agents never write the brief. An Agent-suggested change is a **proposal**
entry (§3) that a researcher accepts or rejects; accepting creates a new
researcher-attributed revision.

### 3. Discussion, decisions, proposals, and observations are attributed entries

`research_entries` is an append-only, per-RQ sequenced log. Each entry records
its `kind` (`note`, `decision`, `proposal`, `observation`), its author
(`researcher`, `agent`, or `system`, plus an optional author reference such as
a Session id), the brief revision current when it was written, and its body
(bounded to 8 KiB). Entries are never edited or deleted.

The Project-scoped API lets the browser (the researcher) record only `note` and
`decision` entries. `proposal` and `observation` entries are created only by
server-side adapters that verify the producing execution (§7), so an Agent
claim is always an attributed interpretation and never approved direction.
Chat-style discussion remains an ordinary Session linked to the RQ (§4); the
entry log holds the points a researcher chooses to pin.

### 4. Association cardinality: one RQ per Session or Team

`research_links` associates an RQ with Sessions and Teams by identifier:

- A given Session, or a given Team, is linked to **at most one RQ**
  (`UNIQUE(kind, ref_id)`). Linking it to a second RQ is a conflict, never a
  silent move.
- An RQ may have many linked Sessions and Teams.
- A link has a `role`: `discussion` (a Session used to talk through the RQ) or
  `execution` (a Solo Session or Team that does work for the RQ).
- Linking validates that the target exists and belongs to the **same Project**;
  a cross-Project target is rejected. Linking is idempotent for the same
  target and role.
- Unlinking removes only the association. It never touches the Session, the
  Team, provider-native history, or any Project file.
- Sessions and Teams that are not linked behave exactly as before, and a
  linked Session or Team has no new behavior until an explicit action uses it.

### 5. Source identifiers and unavailable sources

Research records refer to other records by identifier only; they never embed
content from them. A **source reference** is `{ kind, id }` with `kind` one of
`session`, `run`, `team`, `team_task`, or `file`; a `file` id is a
Project-relative path validated through `WorkspaceService`. The resolved state
of a source is `available`, `changed` (a file whose content revision differs
from the one recorded), or `removed` (the record or file no longer exists).

Local-only deletion keeps its meaning: deleting a Session or unregistering a
Project does not cascade into research rows. Research rows stay, and resolving
a reference to a removed Session, Team, run, task, or file reports `removed`
without exposing any other Project's data. While a Project is unregistered its
RQs are unreachable (every API call validates the Project).

### 6. Linked work, context handoff, and rounds (issue #150)

Starting work from an RQ is an explicit request that creates a **round**
(`POST …/research/{id}/rounds`) — the only research action that can start an
Agent or Team. A round records its number, the **brief revision it consumed**,
its kind (`team` or `solo`), the validated setup exactly as authorized, and
selected **source references** (§5; at most 20, validated to exist in the
Project, a `file` source recording the content revision it was selected at).

- **Pinned context.** The researcher names the revision they are looking at
  (`expected_revision`); a mismatch is a conflict and creates nothing. The
  round stores that revision number, so a later edit can never change what an
  admitted round consumed — revisions are immutable (§2). The UI can show a
  round as *stale* when the brief has moved on.
- **Pre-flight, then durable phases.** The whole request (limits, allowed
  Agents, criteria, Session eligibility, sources) is validated before anything
  is created, so a bad request leaves no Session, Team, or round behind. Setup
  then advances through recorded phases — `created → session_ready →
  team_created → started` — and each side effect is idempotent:
  a Team is created through the existing promote path (a Session belongs to at
  most one Team, so a Team left by a crashed attempt is found again, never
  duplicated); a Solo prompt is admitted under the stable client message id
  `research:{round}`, which run admission already de-duplicates; starting a
  Team reuses the same start path as a manual start (setup validation, allowed
  Agents, limits, native permission handling, human-input behavior), and a
  Team left in `starting` is recovered by the existing Team supervisor.
- **Retries.** A request key (`client_request_id`) is required. Replaying the
  same key and request returns the same round and resumes it if unfinished;
  the same key with a different request is refused. A failed step leaves the
  round at its last durable phase and `POST …/rounds/{id}/resume` continues it.
  Concurrent duplicates are serialized per round. A crash between creating a
  fresh Session and recording it can leave one unused Session behind; that is
  benign and removable like any Session.
- **Association.** A Team round links its Team as `execution` work. Promoting a
  Session that is linked to an RQ — by round or by the ordinary promote route —
  carries the association to the new Team and keeps the Session, its history,
  and its provider identity. An archived RQ is read-only, so promotion does not
  extend its association.
- **Context for members.** The goal states the round and revision and points
  to `team_get_context`, which returns a `research` section for the Leader and
  every member: the pinned revision's brief, the instruction, the sources with
  current availability, a stale flag, and a bounded summary of earlier rounds'
  Teams. It lists references, never transcripts. A Solo round instead renders
  the same bounded brief into the admitted prompt, fixed at admission.
- **Authority.** Team creation limits, allowed Agents, native permissions, and
  human-input handling apply unchanged, and the Leader keeps task decomposition
  and team formation. There is no new scheduler or router.

### 7. Findings and provenance (issue #151)

Findings are attributed, idempotent records that cite their producing
execution (Session, run, Team, task) and validated evidence references (§5).
Observations and interpretations are recorded directly; anything that would
change the approved direction is a proposal requiring a researcher decision
(§3). Publication from a Team uses a per-Team pending-publication record
created in the same transition that completes the Team, so a retry or restart
publishes exactly once and never loses a pending result.

### 8. Events

Every research mutation commits its workspace event in the same transaction
(`research_updated`, content-free: research id and change kind only, scoped to
the Project). Browsers reconcile by refetching on that event after reload or
reconnect, as for other durable domains (ADR 0205).

## Consequences

- A new `research_store` owns the domain and shares the single SQLite
  connection; it composes through `AppState` and a Project-scoped route group.
- Existing Projects, Sessions, and Teams are unaffected until linked.
- Revisions are unconditionally retained; the bound is per revision.
- Cross-Project and cross-RQ confusion is rejected at the store boundary.
- The workbench (issue #152) reads one typed projection per RQ and never owns
  research state of its own.

## Non-goals

Experiment scheduling, metric comparison, GPU or cost accounting, reusable
Workflow templates, a workspace-wide task board, cross-machine federation, and
multi-user collaboration remain later work.
