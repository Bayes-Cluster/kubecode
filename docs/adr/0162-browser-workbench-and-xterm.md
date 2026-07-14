---
type: ADR
id: "0162"
title: "Browser workbench with CodeMirror and xterm"
status: active
date: 2026-07-14
---

## Context

Kubecode replaces Tolaria's desktop vault UI with a Project-oriented browser
workspace. It needs an editor that preserves the existing raw-code behavior and
a real terminal emulator that can attach to the server-owned PTYs.

## Decision

The browser entry point is a three-column React workbench using the existing
shadcn primitives and theme tokens. CodeMirror 6 remains the text editor.
`@xterm/xterm` plus `@xterm/addon-fit` renders terminal sessions and connects to
`TerminalManager` through the cursor-aware WebSocket API.

The Agent panel consumes normalized persisted events rather than importing any
provider SDK into the browser. Project, file, terminal, and Agent requests all
derive their API base from the current Kubeflow `NB_PREFIX` pathname.

## Consequences

- Browser refreshes can reattach to terminals and replay Agent events.
- The frontend never receives arbitrary filesystem paths or CLI credentials.
- xterm is a production dependency and must be updated with the frontend lockfile.
- The previous Tolaria desktop modules remain migration source but are no longer
  the production browser entry point.
