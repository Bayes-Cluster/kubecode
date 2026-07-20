---
type: ADR
id: "0196"
title: "Dynamic Agent catalog and runtime Doctor"
status: active
date: 2026-07-19
supersedes: "0163 where Agent discovery was startup-only"
---

## Context

Standalone installation makes the local CLI and ACP adapter boundary visible
to users. A startup-only Agent list cannot recover after a CLI is installed or
repaired, and a single ACP error string cannot distinguish discovery, adapter,
process, protocol, authentication, and Project-directory failures.

Testing authentication or directory handling requires creating a real provider
Session. Doing that as an invisible health check would leave provider-native
history that Kubecode does not own or delete.

## Decision

Kubecode owns one process-wide, dynamically refreshable `AgentCatalog`.
Session actors, Team coordination, Agent TUI terminals, and the HTTP API read
the same atomic snapshot. A refresh never disconnects an existing Session;
new and reconnecting consumers use the latest snapshot.

Each catalog entry preserves the compatible Agent descriptor and adds separate
CLI and adapter diagnostics, discovery source, readiness, stable error codes,
and a check timestamp. Claude Code and Codex require their configured ACP
adapters. OpenCode reports its ACP implementation as native.

`POST /api/v1/agents/refresh` performs bounded executable and version probes.
The Settings UI presents the result and the empty workspace uses it to guide
Project and Session creation.

`kubecode doctor` and `kubecode doctor --json` reuse the same passive probes
alongside core path, static asset, and Git checks. Doctor never connects to an
account or calls ACP `session/new`. Authentication and Project-specific
directory readiness are checked only when the user creates or restores a real
Session. Those failures return structured startup stages and stable API codes.

## Consequences

- Installing or repairing an Agent no longer requires restarting Kubecode.
- Session, Team, and TUI availability cannot disagree after a refresh.
- “Ready” means that local runtime dependencies are present; it does not claim
  that provider authentication is valid.
- Doctor is safe to run in support workflows and does not create hidden
  provider history.
- Existing connected Sessions may continue after a refreshed catalog marks
  their Agent unavailable, but reconnecting them requires the dependency to be
  ready again.
