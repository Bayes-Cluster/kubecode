# ADR 0178: Capability-aware Team MCP transport

## Status

Accepted. Supersedes ADR 0177 only where it requires the Team MCP server to use an in-process ACP bridge.

## Context

ACP agents advertise the MCP transports they support. The ACP SDK's dynamic in-process bridge is encoded as a special HTTP URL and requires MCP-over-ACP support. Codex advertises ordinary streamable HTTP MCP but not MCP-over-ACP, so treating every agent as bridge-capable produces a failed synthetic `mcp__kubecode-team__startup` tool call and leaves the Team without coordination tools. An in-process bridge also cannot be reattached to a provider session through a separate process after a Kubecode restart.

## Decision

Kubecode serves `kubecode-team` as an authenticated streamable HTTP MCP endpoint inside the Rust server. Each server process generates an unguessable token, and Team MCP URLs bind that token to one durable member conversation. The internal origin defaults to the loopback listener plus `NB_PREFIX` and may be overridden with `KUBECODE_INTERNAL_ORIGIN` for deployments whose agent process uses a different internal address.

After ACP initialization, `AgentRuntime` selects HTTP only when the agent advertises `mcp_capabilities.http`. The same MCP configuration is attached to `session/new`, `session/load`, and `session/resume`, so a persisted Team member retains its tools when its ACP actor is recreated. The existing in-process bridge remains a new-session fallback for agents that do not advertise HTTP.

Team records remain the source of identity after a restart. Project Team listing isolates stale records instead of allowing one missing conversation to hide every valid Team, and deleting a Leader conversation removes its Team coordination record.

## Consequences

- Codex receives a real HTTP MCP URL instead of the unsupported special `acp:` URL.
- Team tools survive Kubecode and ACP process restarts without replacing provider history.
- MCP endpoints are reachable only with the process token and a valid Team member conversation ID.
- Restarting Kubecode rotates the token; load/resume supplies the new URL to the agent.
- A provider without HTTP support still has the earlier in-process new-session fallback, but durable reattachment depends on a transport that its ACP implementation accepts.
