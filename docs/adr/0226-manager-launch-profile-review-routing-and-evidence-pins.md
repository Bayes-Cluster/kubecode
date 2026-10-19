---
type: ADR
id: "0226"
title: "The manager's provider launch profile, review decisions routed to the manager, and review evidence pins"
status: accepted
date: 2026-10-19
supersedes: "0220 where the manager's restriction applies only when its provider asks permission; 0225 where a review decision is not passed to the manager and only work-attached evidence guards acceptance"
---

## Context

The acceptance review of #199 found four holes in what ADRs 0220–0225 promised:

1. The General Agent's restriction to managing was enforced only when its
   provider asked permission. A provider that edits files or runs commands
   without asking — Codex in its default agent mode, for one — let the manager
   do concrete work.
2. When the researcher sent a Task back, the decision was recorded but no one
   told the manager, so the rework was never planned.
3. Evidence the manager cited in the review request itself (`kind:id`) was not
   pinned, and acceptance checked only evidence attached to internal work.
4. The inspector remembered *which* evidence the researcher looked at, not the
   *version*: if the evidence changed again after the look, accepting it pinned
   a version nobody saw.

## Decision

### 1. The manager starts without the tools for concrete work

A Session whose member is the General Agent (public or direct-message) is
started with the **Manager** permission profile. The restriction is part of the
provider's launch, not only of its permission requests:

- Claude Code: `session/new|load|resume` carry
  `_meta.claudeCode.options.disallowedTools` withdrawing `Bash`, `BashOutput`,
  `KillShell`, `Monitor`, `TaskOutput`, `TaskStop`, `PowerShell`, `Edit`,
  `MultiEdit`, `Write`, `NotebookEdit`, and `EnterWorktree`, and the mode is
  set to `default`.
- Codex: the mode is set to `read-only`. Codex may still run a command inside
  its read-only, no-network sandbox without asking; it cannot change the
  workspace, and escaping the sandbox needs a permission request, which is
  refused. The manager may inspect, not change.
- OpenCode: the process starts with
  `OPENCODE_PERMISSION='{"edit":"deny","bash":"deny"}'`.

The mode is part of the restriction, so nothing can widen it afterwards: the
runtime refuses a mode change (by mode or by a mode-category config option) on
a manager Session whoever asks, the session API reports it as locked
(`general_manager`), and the General Agent's settings may not carry a `mode`
value (one stored earlier is never applied).

The runtime still refuses an edit, delete, move, or execute permission request
from a manager Session, and puts any other request it makes to the researcher
every time instead of answering it from always-allow memory. Kubecode's own
tools are unaffected. If the roster cannot be read when a Session starts, the
Session starts restricted and the error is logged. Specialists keep the Default
profile.

### 2. A review decision is routed to the manager

Recording the researcher's decision on a review creates one durable `task_review`
route (source: the review) to the General Agent's public Session. Accepting asks
the manager to close out and report in General; sending back says the Task is In
progress again and quotes the researcher's reasons as data, asking the manager to
plan the rework without widening the Task's scope. The route is idempotent per
review and survives a restart like every other route.

### 3. Review evidence is pinned when it is cited

`request_review` pins every `kind:id` it cites to the evidence's current
revision and refuses evidence that does not exist. The Task's stale evidence
includes the open review request's own pins (with its `request_id` and an empty
`work_id`), so acceptance is refused with `409 work_evidence_stale` while any of
them changed. `POST …/repin` with `request_id` re-pins one of them, bound to the
revision the researcher looked at, which is required.

### 4. The researcher accepts only the version they looked at

The inspector records the revision shown by "Look at it". "Accept the current
version" is enabled only while that revision is still the current one, and it
re-pins exactly that revision; if the evidence changes again, it must be looked
at again. Evidence pinned more than once (by internal work and by the review)
is shown once and accepting re-pins each pin; if one of those calls is refused,
the rest stay stale and are shown again.

## Consequences

- A manager cannot edit files or change the workspace, on providers that ask
  permission and on those that do not, and its mode cannot be widened later.
- Sending a Task back reaches the manager without the researcher repeating
  themselves in General.
- Every piece of evidence a review names is version-guarded the same way.
- Known limits: MCP servers the user configured for Claude Code or OpenCode
  themselves are not withdrawn (their requests reach the researcher); the
  decision's route is written after the decision commits, so a crash between the
  two loses the notice (it is logged when routing fails); a review request
  opened before this change has no pins of its own.
- A real-agent pilot of the launch restrictions has not been run; they are
  covered by tests of the launch configuration and the installed adapters'
  option names.
