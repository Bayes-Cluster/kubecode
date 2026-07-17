# ADR 0184: Hidden Agent Chat revisions

## Status

Accepted. Supersedes ADR 0174 for Edit, Regenerate, and Undo. Explicit Fork
continues to create a visible Agent Chat.

## Context

ACP does not define turn-level mutation or rewind. Creating a visible Session
for every edit preserves history but makes the Session list diverge from the
user's intent and breaks Team identity.

## Decision

Kubecode keeps one stable logical Session and snapshots the current runs,
events, checkpoints, and provider identity before revising a completed turn.
Snapshots are hidden from Session queries and exposed through a per-Session
revision API. The active timeline retains the prefix before the selected run,
starts a fresh provider Session with recreated context, and never restores
Project files implicitly. Earlier snapshots are read-only and navigable.

## Consequences

- Editing and regeneration do not add a sidebar Session or change Team roles.
- Previous responses remain auditable without constraining provider-specific
  session implementations.
- Explicit Fork remains available when the user actually wants another Session.
- Deleting the logical Session also deletes its hidden snapshots.
