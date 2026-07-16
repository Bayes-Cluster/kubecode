---
type: ADR
id: "0174"
title: "Immutable Agent Chat branches"
status: active
date: 2026-07-16
---

## Context

ACP does not currently define turn-level edit or rewind. Provider-native
capabilities also differ: whole-session fork is not equivalent to editing a
completed user turn, and relying on one provider's private rewind behavior
would make the timeline inconsistent across Claude Code, Codex, and OpenCode.

## Decision

**Undo, Edit, and Regenerate create a new Agent Chat branch and never mutate
stored history.** The branch retains timeline events before the selected run,
shares the parent Agent Session's cwd/worktree, and starts without a provider
Session ID. Kubecode embeds the retained transcript as initialization context
for the branch's first prompt and labels it `Recreated context`.

The source Chat remains complete and navigable. Branch relationships are stored
separately from provider-native fork and subagent relationships. A later ACP or
provider capability may replace recreated context with a native turn fork, but
only when its semantics are equivalent and capability-driven.

## Consequences

- Completed replies can be regenerated and user messages can be edited without
  deleting audit history.
- Interrupted, failed, or cancelled turns can be undone by branching before the
  affected run.
- Branch Chats share the same execution directory and therefore do not imply a
  new Git worktree.
- Recreated context is explicit because it may differ from a native provider
  checkpoint in hidden model state.
