---
type: ADR
id: "0194"
title: "Standalone Linux distribution"
status: active
date: 2026-07-19
supersedes: "0161, 0162, 0163, 0166, 0171, 0178 where they require Kubeflow, containers, NB_PREFIX, or PERSISTENT_DIR"
---

## Context

The active product is a Rust server and React browser workspace. Its container
and Kubeflow assumptions made local installation harder, coupled state paths to
one image layout, and duplicated provider Agent CLIs whose authentication and
updates are intentionally host-owned.

Claude and Codex still require Node-based ACP bridges. A bare Rust executable
would therefore not be a complete runtime.

## Decision

Kubecode publishes self-contained `linux-amd64` and `linux-arm64` archives in
the style of code-server standalone releases. An archive contains the React
build, musl-linked Rust server, pinned Node.js runtime, and production-only
Claude/Codex ACP adapter dependencies. Optional native provider packages are
omitted. Claude Code, Codex, OpenCode, Git, credentials, and shells remain
external host dependencies.

A relocatable `bin/kubecode` launcher supplies archive-relative static and
adapter paths. The server uses command-line options backed by `KUBECODE_*`
environment variables. It listens on loopback by default, uses `$HOME` as the
workspace picker root, and stores state under the XDG data directory.
`NB_PREFIX`, `PERSISTENT_DIR`, `HOST`, and `PORT` remain deprecated migration
fallbacks.

GitHub Actions builds and smoke-tests both architectures on native runners.
GitHub Releases contain versioned tarballs and SHA-256 checksums. A rootless
installer places versions below `~/.local/lib` and links
`~/.local/bin/kubecode`.

Kubecode does not publish an official container, Kubernetes resource, Kubeflow
manifest, system service, or built-in remote-access authentication.

## Consequences

- One release archive runs without a host Node.js or Rust toolchain.
- Agent authentication and upgrades remain authoritative in provider CLIs.
- Downstream containers and cluster integrations consume the same standalone
  archive but own their routing, security, users, and persistence.
- Non-loopback listeners require an authenticated external boundary.
- macOS, Windows, deb, rpm, and service integration remain future work.
