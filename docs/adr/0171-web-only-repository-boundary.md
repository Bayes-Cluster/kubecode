---
type: ADR
id: "0171"
title: "Web-only repository boundary"
status: active
date: 2026-07-16
---

## Context

Kubecode's production path is the React browser client, standalone Rust server,
and Kubeflow container. The repository still carried a complete desktop app,
desktop release pipeline, public documentation site, demo vaults, and historical
assets that were not used by the Kubecode build.

## Decision

**The repository targets the Kubecode web and Kubeflow product only.** Remove
inactive desktop, release, documentation-site, demo, and MCP-server assets.
Keep shared React primitives while they remain dependencies of the current web
workspace, and retire them incrementally when replaced.

## Consequences

- Build, CI, local hooks, and documentation describe one deployable product.
- The active Rust crate is `server/`; Tauri is not a supported target.
- Historical source remains available in Git history rather than the working tree.
- Shared frontend primitives may retain internal legacy names until replacement
  is worthwhile, but no inactive product surface is shipped.
