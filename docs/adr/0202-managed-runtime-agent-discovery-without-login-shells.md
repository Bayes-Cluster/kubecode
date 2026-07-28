---
type: ADR
id: "0202"
title: "Managed Runtime Agent discovery without login shells"
status: active
date: 2026-07-24
supersedes: null
---

## Context

Agent discovery historically used a login shell as a final executable lookup
fallback. This helps standalone servers inherit shell-managed PATH changes, but
it is unsafe for a Runtime launched by a native application: user login files
may attach to a terminal multiplexer, create another interactive shell, or run
long-lived commands. Repeating discovery can then create unbounded shell
processes and memory pressure.

The macOS client already reconstructs a deterministic PATH containing common
Homebrew, local, npm, bun, and OpenCode locations. Runtime discovery also scans
known mise, asdf, nvm, Claude, Codex, and OpenCode installation paths.

## Decision

`KUBECODE_DISABLE_LOGIN_SHELL_DISCOVERY=1` disables only the login-shell
fallback. Explicit `KUBECODE_*_PATH` overrides, inherited PATH lookup, known
installation locations, executable validation, version probes, and dynamic
catalog refresh remain unchanged.

Managed native clients set this variable when launching their owned Runtime.
Standalone Linux and SSH-managed Runtime processes retain the existing fallback
unless their operator explicitly sets the variable.

This switch does not affect Agent TUI execution. An Agent TUI still starts its
already-discovered executable through the user's interactive login shell so
provider authentication and gateway configuration remain available.

## Consequences

- Launching the native App cannot execute arbitrary login-file startup logic
  merely to locate an Agent CLI.
- Native discovery remains deterministic and cannot accumulate lookup shells.
- Operators with unusual installations can use an explicit executable override
  instead of relying on shell side effects.
- Agent TUI behavior and custom provider gateway configuration are preserved.
