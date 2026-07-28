# ADR 0204: Bounded Tokio ACP Session actors

## Status

Accepted

Supersedes ADR 0164's ACP process transport, thirty-minute idle timeout, and
unbounded warm-actor implementation details.

## Context

An ACP adapter remained attached to every initialized Session for up to thirty
idle minutes. Team draft creation also initialized a persistent Leader actor
before the Team started. A Project with many Sessions or Teams could therefore
retain many child processes. The previous stdio bridge polled idle pipes through
an executor path that consumed CPU even when no Agent was working.

## Decision

- ACP stdio adapters use Tokio child-process and asynchronous pipe primitives.
  Adapter lifetime is owned by the Session actor and process cancellation kills
  the child.
- An inactive Session actor exits after two idle minutes. At most four inactive
  actors remain warm across the Runtime. Least-recently-used inactive actors are
  shut down when the bound is exceeded.
- An actor with an active prompt is never selected for warm-pool eviction.
- Session provider state remains durable. A later prompt recreates the actor and
  resumes or loads the stored provider Session ID.
- Team draft creation and Session promotion may initialize or reconnect ACP
  state ephemerally. They persist provider identity and then release the actor;
  starting the Team wakes the Leader again.
- Runtime diagnostics expose active and idle Session actor counts without
  exposing prompts, paths, credentials, or provider payloads.

## Consequences

Idle Projects have a fixed process and memory ceiling, and unused Team drafts do
not keep shells or adapters alive. The first prompt after eviction pays adapter
startup and provider resume latency. Lifecycle tests must cover the warm bound,
ephemeral initialization, active-run protection, and reconnect behavior.
