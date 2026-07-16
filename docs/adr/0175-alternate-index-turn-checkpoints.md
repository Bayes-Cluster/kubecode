---
type: ADR
id: "0175"
title: "Alternate-index turn checkpoints"
status: active
date: 2026-07-16
---

## Context

An immutable Chat branch is incomplete if Edit, Regenerate, or Undo leaves the
filesystem at an unrelated later state. Kubecode must capture untracked,
staged, and unstaged content without changing the user's real Git index,
branch, or staging choices. Shared Project roots also need stronger overwrite
protection than isolated worktrees.

## Decision

**Capture a Git tree before and after each Agent run with a private alternate
index.** `GIT_INDEX_FILE` points at short-lived state below Kubecode's private
directory; `read-tree`, `add --all`, and `write-tree` produce durable tree IDs
without touching the repository's real index. The temporary index is removed
after capture.

Restoration diffs the current captured tree against the target tree and applies
that patch to the working files only. In Shared mode, the current tree must
match the recorded after-turn tree before restoration. A mismatch returns a
checkpoint conflict and never overwrites files silently. Worktree Sessions may
restore within their isolated execution boundary without that Shared-mode
fingerprint requirement.

## Consequences

- Turn checkpoints include untracked and staged content while preserving the
  user's actual staging area.
- Chat branching can restore the selected turn's pre-run filesystem state.
- Non-Git Projects still support immutable Chat branches but cannot restore a
  Git checkpoint.
- Git objects created for checkpoints follow normal repository object pruning.
