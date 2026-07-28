---
type: ADR
id: "0201"
title: "Authenticated headless Runtime clients"
status: active
date: 2026-07-22
---

## Context

Kubecode's browser distribution owns its React assets and can rely on an
external reverse proxy when exposed remotely. Native clients need to manage the
same server without embedding the browser UI, without choosing a fixed local
port, and without exposing an unauthenticated loopback API to other processes.

## Decision

The Rust executable supports an explicit API-only launch contract. A managing
client binds it to loopback on port zero, sends a high-entropy bearer token on
standard input, and reads one JSON readiness document from standard output.
The token never appears in process arguments, logs, discovery, or readiness
output.

API-only mode publishes `/.well-known/kubecode` and the versioned `/api/v1`
surface without static assets. Discovery is public and contains only protocol
version, server version, API base, authentication scheme, and capabilities.
Every REST, SSE, WebSocket, and MCP route below `/api/v1` shares the same bearer
boundary. Existing browser mode and generic base-path behavior remain intact.

Native clients are maintained in the separate `kubecode-desktop` repository.
This repository remains the Runtime and protocol source of truth and does not
gain platform UI code or desktop release workflows.

## Consequences

- A local native client can start and discover a private Runtime without port
  races or credentials in `ps` output.
- Remote and cluster deployments can expose the same protocol behind their own
  authenticated HTTPS boundary.
- Protocol changes require an explicit version or backwards-compatible fields.
- Provider credentials and provider-native history remain outside the client.
