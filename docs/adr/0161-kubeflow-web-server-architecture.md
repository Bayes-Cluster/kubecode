---
type: ADR
id: "0161"
title: "Kubeflow web server architecture"
status: active
date: 2026-07-14
supersedes: "0001"
---

## Context

Kubecode runs inside a single-user Kubeflow Notebook Pod. A Tauri process and
desktop WebView are not available there, while the browser still needs safe
filesystem access, durable project metadata, terminals, and local CLI agents.

## Decision

**Use a standalone Rust/Axum server as the platform boundary and keep React as
the browser client.** The server owns path validation, SQLite state, processes,
PTYs, and provider protocols. Browser code uses versioned HTTP, SSE, and
WebSocket APIs that are rooted below the configured Kubeflow base path.

Project files remain the source of truth. SQLite stores only application
metadata, conversations, normalized events, and permission rules under
`$PERSISTENT_DIR/.state/kubecode`.

## Consequences

- The container does not need Tauri, WebKit, or native window APIs.
- A future desktop client can connect to the same protocol instead of requiring
  a second backend implementation.
- Every filesystem request is resolved by the server against a registered
  project and canonical persistent root.
- Existing Tolaria UI components may be reused, but Tauri-only product flows
  are outside the Kubecode runtime.
