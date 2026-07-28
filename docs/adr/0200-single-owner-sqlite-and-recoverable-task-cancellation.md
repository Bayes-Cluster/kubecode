---
type: ADR
id: "0200"
title: "Single-owner SQLite and recoverable task cancellation"
status: active
date: 2026-07-22
supersedes: "0183, 0186, and 0188 where they leave SQLite connection ownership and cancelled required work unspecified"
---

## Context

Workspace, Agent, and Team stores opened separate connections to the same
SQLite file and unconditionally enabled WAL. Team result review uses a
read-before-write transaction, while Agent events, mailbox acknowledgement,
activity, and supervisor reconciliation can write concurrently. A stale WAL
snapshot can therefore fail promotion to a writer with `SQLITE_BUSY`, and WAL's
shared-memory design is not suitable for a database on a network filesystem.

Cancelling a required task also left `completion_required` set. The task still
blocked Team completion, while retry accepted only failed work, leaving no
normal recovery transition.

## Decision

One Kubecode server process owns one SQLite connection. `WorkspaceService`,
`AgentStore`, and `TeamStore` share that connection behind a process-wide
mutex. A separate owner lock prevents a second Kubecode server from claiming
the same state database.

SQLite uses the rollback `DELETE` journal, `synchronous=FULL`, foreign keys, and
an explicit five-second busy timeout. Existing WAL databases are converted by
SQLite during the single-owner startup path; Kubecode never deletes WAL or
shared-memory files manually. Multi-statement writes begin with
`BEGIN IMMEDIATE`, and related Team task, attempt, activity, and mailbox changes
commit together. Provider calls and filesystem changes remain outside database
transactions.

Cancelling a task means the work is no longer required. The transition clears
`completion_required`, cancels active attempts and unresolved task deliveries,
and retains history. Retrying failed or cancelled work restores
`completion_required` and recalculates whether dependencies make it pending or
blocked. Existing cancelled required tasks and deliveries are repaired
idempotently when Team storage opens.

## Consequences

- In-process reads and writes are serialized, so WAL read/write concurrency is
  intentionally traded for deterministic Team state transitions.
- A second Kubecode server fails startup instead of competing for the same
  SQLite file.
- Rollback journaling avoids WAL snapshot promotion and shared-memory failure
  modes, but durability still depends on the configured filesystem correctly
  implementing locking and `fsync`.
- Multi-server state requires a future client/server database ADR rather than
  weakening the single-owner contract.
- Cancelled work remains auditable and can either stay waived or be explicitly
  retried without administrator database edits.
