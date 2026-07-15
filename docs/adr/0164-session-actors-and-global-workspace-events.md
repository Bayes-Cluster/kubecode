# ADR 0164: Session actors and one global workspace event stream

## Status

Accepted

## Context

ADR-0163 introduced ACP but launched a fresh adapter process for every prompt
and exposed one SSE per run. That preserved provider session IDs but did not
provide the connected, multi-Session workspace expected by the browser UI.

## Decision

- Every Kubecode Session has a fixed Agent and at most one active run.
- `AgentRuntime` keeps one ACP actor/process per active Session. Different
  Session actors may run concurrently; prompts inside one actor are serialized.
- An actor exits after thirty idle minutes. Its next prompt starts the adapter
  and attempts `session/load` with the stored provider Session ID.
- Agent, file, Git, and Terminal metadata are appended to a durable global event
  log. The browser uses one cursor-replayable SSE; PTYs retain their own
  bidirectional WebSockets.
- Safe-mode ACP permissions wait for a browser-selected protocol option. Power
  mode remains an explicit auto-allow choice.
- Runs persist the user prompt so a refreshed browser can reconstruct the full
  Session timeline.

## Consequences

Sessions stay warm across normal turns without coupling their lifecycle to an
HTTP request. The server must bound idle actors and event history, while clients
must treat snapshots as authoritative after a missed-event resync.
