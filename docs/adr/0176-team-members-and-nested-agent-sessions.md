---
type: ADR
id: "0176"
title: "Team members and nested Agent Sessions"
status: active
date: 2026-07-16
---

## Context

Parallel Agent conversations are not automatically isolated execution
environments. Treating every team member as a new worktree prevents deliberate
collaboration, while silently sharing every cwd makes comparison and risky
experiments interfere with the lead Agent.

## Decision

**A Team member is a separate Agent Chat that shares the parent's Agent Session
by default.** It may use Claude Code, Codex, or OpenCode independently while
retaining the same `agent_session_id`, cwd, and worktree. The relationship is
stored as `team_member`, distinct from provider-native subagents and Chat
branches.

When the user explicitly enables isolation for a Team member, Kubecode creates
a nested Agent Session and Git worktree from the parent workspace's current
HEAD. The child receives its own `agent_session_id` and cwd while retaining the
parent Chat relationship for navigation.

## Consequences

- Team collaboration sees the same files by default.
- Cross-Agent team members can use independent provider Sessions in one cwd.
- Isolation is visible and explicit instead of being inferred from the Agent.
- Comparison Groups can later require isolated child Agent Sessions using the
  same execution-boundary model.
