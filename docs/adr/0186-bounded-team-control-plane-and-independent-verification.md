# ADR 0186: Bounded Team control plane and independent verification

## Status

Accepted. Supersedes the lineup-approval and completion semantics in ADR 0177,
ADR 0183, and ADR 0185. Provider-native configuration and member lifecycle from
ADR 0179 remain in force.

## Context

A durable multi-Agent Team needs stronger completion and failure semantics than
a shared mailbox. Lineup proposals make a capable Leader wait for the user even
when the user has already defined a safe Agent and concurrency budget. A member
can also finish, hit a provider limit, or disconnect without submitting a
structured result, leaving the Leader waiting indefinitely. Finally, an
autonomous Team needs an evaluator that is independent from both implementation
and final synthesis.

## Decision

A Team is created as a Draft. The user starts it with a goal, acceptance
criteria, an allowlist of installed Agent backends, teammate and concurrency
limits, and either Standard or YOLO mode. Within this budget the fixed Leader
may create, configure, replace, and coordinate teammates without a lineup
approval. Provider-native subagents remain inside their owning ACP Session.

The Leader cannot own a concrete Team task, but may inspect and edit the shared
workspace to integrate accepted results. Teammates own concrete tasks. Every
delegation or claim creates a durable task attempt that binds to the resulting
Agent run and records missing reports and structured failure kinds. Failed work
is reopened only through an explicit Leader retry.

Completion is an explicit `team_complete` transition. Required tasks must exist
and be accepted, and no permission or delivery work may remain unresolved.
Standard Teams may escalate teammate permissions to the user after Leader
review. YOLO Teams do not escalate: the Leader must select an advertised native
option or the Team stops for attention.

YOLO also requires an independent Discriminator round. Kubecode selects a fresh
allowed Agent Session, requires an Agent-advertised read-only mode, captures the
Git workspace fingerprint, and exposes only context and verdict tools. The
Discriminator cannot own tasks, edit the implementation, or send arbitrary Team
messages. A rejection starts another Leader loop and cannot be overridden. A
pass is valid only for its captured workspace fingerprint; reaching the user
configured round limit moves the Team to Needs Attention.

Kubecode enables YOLO only when the Leader Agent explicitly advertises its
native autonomous option. It maps Claude Code bypass permissions, OpenCode auto,
or Codex YOLO / approval-never plus danger-full-access settings without
inventing model or permission IDs.

## Consequences

- Team Board is the primary Team surface; member and verifier transcripts remain
  independent durable Sessions.
- Runtime state survives browser and server restarts without reconstructing
  authority from prompts.
- Non-Git workspaces can run Standard Teams but cannot claim an independently
  fingerprinted YOLO verification pass.
- Legacy proposal records remain readable as history but are no longer exposed
  to the Leader or used to authorize member creation.
