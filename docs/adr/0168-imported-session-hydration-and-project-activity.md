# ADR 0168: Imported Session hydration and Project activity

## Status

Accepted

## Context

An imported provider Session already has a native transcript. Connecting it
with `session/resume` restores execution context but does not require the Agent
to replay that transcript, leaving a newly imported Kubecode timeline empty.
The Project rail also had no persisted view of run state, so work running or
waiting for the user in another Project was invisible until that Project was
opened.

## Decision

- A newly imported provider Session uses `session/load` when the Agent
  advertises it. ACP history notifications are persisted before the Session is
  considered ready. Later reconnects continue to prefer `session/resume` and
  avoid replaying already stored history.
- The server exposes Project-scoped run history. The Project rail reduces the
  latest run of each Session into `running`, `stuck`, or idle presentation.
- Permission and elicitation requests persist `waiting_permission` while the
  Agent is blocked and return the run to `running` after the user responds.
- The global workspace event stream updates Project indicators live; the
  Project run endpoint supplies initial state after a browser reconnect.

## Consequences

Imported Claude Code, Codex, and OpenCode Sessions render their native history
on first open without creating a synthetic prompt. Users can see active or
attention-required work across Projects, and the indicator remains correct
after browser refresh. Project status is derived from Agent runs rather than a
separate mutable Project flag.
