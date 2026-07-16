---
type: ADR
id: "0173"
title: "Optional Project Workspaces and Agent Session cwd"
status: active
date: 2026-07-16
---

## Context

Parallel coding Sessions need an explicit filesystem boundary. Treating every
chat as Project-root work makes independent Agents race over the same files,
while always creating a Git worktree surprises users who want one shared
working tree. ACP also binds provider Sessions to a cwd, so changing only the UI
label would not create isolation.

## Decision

**Projects opt into Workspaces, and each Agent Session owns its execution mode
and cwd.** Workspaces are disabled for new and existing Projects by default.
When enabled, a newly created Session may use the shared Project root or a
server-managed Git worktree under Kubecode's private state directory.

The durable Agent Session identifier, execution mode, and optional worktree
path are stored with the existing conversation record during the compatibility
phase. Existing records migrate one-to-one: their Agent Session ID equals their
conversation ID and their execution mode is `shared`. `AgentRuntime` resolves
the stored execution path for every ACP create, load, resume, fork, and prompt
operation; it never silently changes a worktree Session back to Project root.

Worktree creation invokes Git directly without a shell. The path is derived
only from server-owned IDs, remains outside Project content, and is rejected
unless the Project preference is enabled.

## Consequences

- Users can choose isolation per new Session without changing the Project path.
- Existing Sessions and imported provider Sessions retain shared-root behavior.
- Same cwd currently maps one-to-one to the compatibility Agent Session record;
  multiple Agent Chats can be introduced additively without changing cwd
  ownership.
- Disabling Workspaces requires a separate protected migration flow; toggling
  the preference alone must not delete or abandon worktree changes.
- Worktree mode requires a Git repository with an initial commit.
