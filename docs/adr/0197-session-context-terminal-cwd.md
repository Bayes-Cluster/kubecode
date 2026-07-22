---
type: ADR
id: "0197"
title: "Session-context terminal cwd"
status: active
date: 2026-07-21
---

## Context

Projects may contain Agent Sessions that execute either in the shared Project
root or in a server-managed worktree. Terminals were created with only a
Project identifier, so opening the terminal dock from a worktree Session still
started the PTY in the shared Project root. Moving an existing PTY whenever the
selected Session changes would also make its filesystem context unpredictable.

The browser must not supply an arbitrary server path to select a cwd. Session
execution paths remain server-owned state and must continue through the
`WorkspaceService` boundary.

## Decision

Terminal creation accepts an optional Agent Session identifier. The server
loads that Session, verifies that it belongs to the requested Project, and
resolves its stored workspace path through `WorkspaceService::execution_path`.
Without a Session identifier, the terminal continues to use the Project root.

Each PTY records the optional Session identifier used at creation. Its cwd is
immutable for the lifetime of that PTY: changing the selected Session affects
only newly created terminals. Split terminals and restarted terminals inherit
the source terminal's Session context rather than the currently selected
Session.

Terminal groups and split layouts remain Project-scoped presentation state.
The Session identifier is execution context, not a new persistence or lifetime
owner for the PTY.

## Consequences

- A terminal opened from a worktree Session runs in that worktree; shared and
  imported Sessions run in the Project root.
- Existing terminals do not silently change directories when the user selects
  another Session.
- The terminal API exposes Project and Session identifiers only. It does not
  expose an arbitrary cwd parameter.
- A missing Session or a Session from another Project cannot be used to create
  a terminal.
