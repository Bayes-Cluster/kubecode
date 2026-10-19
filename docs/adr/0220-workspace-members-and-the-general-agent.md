---
type: ADR
id: "0220"
title: "Workspace members, the General Agent, and role-bounded authority"
status: proposed
date: 2026-10-19
---

## Context

Until now the unit a researcher organized work around was a Session, or a Team
of Sessions with a Leader (ADRs 0176-0188). ADR 0217 let a round's Session
coordinate, create executor Sessions, and execute work itself. Nothing gave
an agent a stable identity across the places it appears (the shared
conversation, a private message, a task assignment), nothing guaranteed that a
Workspace has a project manager, and the line between *managing* research and
*doing* it was only a prompt. The blueprint for the Research Workspace (#199)
makes Agents and Tasks the main objects and requires that boundary to be
enforced by the service, not suggested to the model.

## Decision

### 1. A member is a durable identity; a Session is how it runs

`member_store` owns **members** of a Workspace (a registered Project):

- `role`: `general` (the project manager) or `specialist`.
- `template`: `general`, `analysis`, `writing`, `code_review`, or `custom`.
  The template names *responsibility*; it is separate from the **specification**
  (provider, configuration values such as model and reasoning effort,
  base instructions, and a permission mode). Changing one never changes the
  other.
- `public_conversation_id`: the Session used for work in the shared
  conversation and for task assignments. `dm_conversation_id`: a *different*
  Session used for the human-agent direct message (created when the first DM
  exists, ADR to follow with #202). The two bindings never share context, so
  the same member can serve both without leaking one into the other.
- `state`: `active`, `setup_required` (the provider or configuration is
  unavailable; the error is recorded and recoverable), or `removed`.

Assignments, messages, and history refer to the member. Replacing its Session
(a broken Session, a provider change) swaps the binding and keeps the id; the
old Session stays attributed to the member in `member_sessions` but is no
longer the member's, so it has no authority and cannot be assigned. Both
replacement and removal are refused while the member holds an open assignment
(reassign first); replacement is also refused while an attempt is running.
Removing a member keeps its row, name, and every record that cites it.

### 2. Exactly one General Agent per Workspace, bootstrapped idempotently

A partial unique index allows one non-removed `general` member per Project.
`ensure_general` inserts the member row first, then creates its Session, then
binds it with one conditional write; a retry, a concurrent caller, or a restart
between the steps converges on one member and one Session (a surplus Session
created by a lost race is deleted). New Workspaces get the General Agent at
creation; an existing Workspace gets it the first time its roster is read. It
is never restarted and never duplicated. If the default provider is not
installed or the configuration is invalid, the member is created in
`setup_required` with the reason, and fixing the defaults and retrying
completes it.

### 3. Defaults are server state

The default specification for the General Agent (and the templates offered for
specialists) lives in the database, revision-checked, not in browser
preferences: a browser preference would give different tabs different
managers. Configuration values are provider-reported option ids (for example
`model`), applied through the Session's existing configuration command and
checked against what the Session reports as available; an option the provider
does not report is a setup error, not a silent no-op.

### 4. The manager manages; it does not do the research

The General Agent clarifies goals with the human, proposes and (on a human's
authorization, ADR 0221) admits Tasks, plans, delegates to specialists, tracks
progress, and reports and escalates to the human. It is refused, in the
service and the tool layer, from: being assigned work, launching or analyzing
experiments, attaching evidence or reporting an attempt as an executor, and
reviewing as a specialist. These checks read the member role from persisted
state on every call, so a prompt, a configured instruction, or a message from
another agent cannot lift them, and no other agent can grant the manager
authority. Specialists may report and propose; their reports inform the
manager but do not carry human authority.

### 5. Existing Workspaces

Existing Sessions, Teams, rounds, and work are unchanged and stay readable.
They are not turned into members: legacy Sessions remain execution details.
Coordinators seated under ADR 0217 before a Workspace had a General Agent keep
their seat until the round is handed to the manager; the manager boundary
applies to the manager's own Session, not retroactively to others.

## Consequences

The roster is the one place that says who works in a Workspace and in what
role. The persistence of defaults is a new store; instruction delivery is
once per Session revision (a role brief prepended to the first routed prompt
after a member's specification changes), so a long Session is not re-briefed
on every message. Provider-specific model catalogs are not duplicated here:
the Session reports its options and the member specification names the ones it
wants. ADRs 0176-0188 (Team-first organization) and the executor-creation and
self-execution parts of ADR 0217 §2-3 are superseded for new Workspace work
by the member roster; the Team runtime itself remains for existing Teams.
