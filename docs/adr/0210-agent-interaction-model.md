# ADR 0210: Agent Interaction Model (queue, optimistic send, typed stops, boundary fork)

## Status

Accepted

Shapes the contracts implemented by the #87 epic. Extends ADR 0164 (session
actors and workspace events), ADR 0200 (single-owner SQLite), ADR 0203
(batched agent runtime events), and ADR 0204 (bounded Tokio ACP session
actors); supersedes ADR 0174's revise/branch fork mechanisms with one
completed-turn boundary primitive.

## Context

Agent conversation interactions are unresponsive and inconsistent. Sending
while a run is active is impossible (the composer returns early, the server
answers 409 `StoreError::ActiveRun`), user bubbles appear only after
`POST /runs` resolves, and the handler runs SQLite transactions and git
`read-tree`/`write-tree` subprocesses inline. Stop is not idempotent, surfaces
`RunNotActive` on late deletes, and convergence is refetch-driven even though
a cursor-based SSE stream exists. Fork/rewind has three coexisting mechanisms
that all drop provider-native history. Dormant infrastructure
(`agent_permission_rules`, `PromptResponse.usage`, subagent relationships)
delivers no user value, per-agent quirks are scattered across `match agent_id`
arms, terminal transcripts die with the process, the session-event table grows
per notification, and streaming markdown re-parses the whole document per
delta.

Two upstream codebases were studied in 2026-08:

- **deepseek-ai/deepseek-harness** contributes the interaction *contracts*:
  a non-blocking inbox (follow-up / steer / inject), cooperative typed
  cancellation with `keepInbox`, turn-end reasons as durable facts, fork as a
  first-class log-boundary operation, and whole-snapshot frames for transient
  state.
- **Zythum/fello** — same architecture class as Kubecode (ACP client + web
  UI) — proves the pragmatic mechanics over ACP: optimistic user bubbles
  reconciled by a client-generated display id echoed back through event
  metadata, typed `prompt-end` stop reasons with zero-refetch convergence,
  send-while-streaming as cancel-and-replace, a reducer-replay kernel, a
  per-agent ACP adapter pipeline, an agent-agnostic subagent envelope,
  kind-granular always-allow memory, usage as session metadata, durable
  per-terminal logs, transcript hygiene, and block-level streaming markdown.

Deliberately **not** adopted: Cordis and any in-process plugin framework
(Kubecode is a Rust/Axum orchestrator of ACP subprocesses), fello's capability
surface (project memory, user MCP servers, skills, automation — deferred),
its no-migration JSONL storage (Kubecode's SQLite event store stays), and its
single-socket request/response correlation (REST + SSE stays).

ACP has no native mid-turn steering primitive; "send now" is approximated by
cancel-and-replace.

## Decision

### 1. Client message ids and optimistic send

Every `POST /runs` carries a client-generated UUID (`client_message_id`). The
server persists it on the run row and echoes it in the `session/user` event
created for that run, and in the run's terminal event. The web client renders
the user bubble optimistically before the request resolves; reconciliation is
by `client_message_id` (dedupe, not duplicate). Rollback classification:

- transport failure (request never reached the server) — roll the bubble back
  to a retryable draft state;
- generation failure (run rejected or terminal-errored) — keep the bubble,
  surface the terminal cause on it.

`client_message_id` is opaque correlation metadata; it never carries prompt
content and never enters analytics.

### 2. Durable per-conversation prompt queue

A run start against a conversation with an active run **enqueues** instead of
409ing. The queue is a durable SQLite table keyed by conversation, drained
FIFO by the session actor at turn boundaries. Queue items support edit,
remove, and send-now (send-now jumps the item to the head). Cancellation
(`DELETE /runs/{id}`) keeps the queue by default; the UI may clear it
explicitly. The queue is surfaced as a whole-snapshot frame (below) — clients
never reconstruct it from deltas.

### 3. Steer-now via cancel-and-replace

"Send now" while a turn is streaming = cancel the current run (cooperative,
with kill-by-session terminal cleanup) and start a new run with the steered
prompt as the next turn. The steered prompt is not lost: cancel-and-replace is
atomic on the server (new run start that references the cancelled run id
succeeds even mid-cancel). This is an explicit approximation; no attempt is
made to inject mid-turn through ACP.

### 4. Idempotent, exactly-once cancellation

`DELETE /runs/{id}` is idempotent: cancelling an already-terminal run returns
success (with the recorded terminal cause), never `RunNotActive`. Exactly-once
semantics: at most one terminal event per run is ever persisted or emitted,
guarded by a compare-and-set on the run row; late duplicate cancels, actor
death, and normal completion race to the same single outcome. Cancellation
kills the conversation's owned terminals (by session, before the ACP cancel)
so stop leaves no orphaned processes.

### 5. Typed terminal causes

Every run termination persists and emits a typed cause, drawn from
`end_turn | cancelled | error | max_tokens | max_turn_requests | refusal | interrupted`.
Mapped from ACP `stopReason` where present, from local state otherwise
(cancel requested, actor/process death, timeout). Terminal events are the
convergence signal: the web client transitions run/conversation state from
the terminal event alone, without refetching.

### 6. Whole-snapshot transient frames

Transient conversation state — queue contents, streaming status, pending
permission requests — is delivered as whole-snapshot frames on the existing
SSE event stream (new frame/event types, no new transports). Snapshots are
idempotent to apply and safe to replay; they are derived state and may be
regenerated at any time from durable records. On reconnect the client
receives cursor-gapped events plus current snapshots and reconciles, instead
of refetching full lists.

### 7. Boundary fork (unified rewind)

One primitive cuts the event log at a **completed-turn boundary** and replaces
the three coexisting mechanisms (provider-native fork, `turns/{id}/branch`,
`turns/{id}/revise`). A boundary is the persisted event position after a
terminal run event. Semantics:

- If the agent advertises a native fork capability, the server forks the
  provider-native session and the provider session id is retained; provider
  history survives.
- Otherwise the server creates a new conversation with a null provider
session id and rebuilds context from the prefix (existing `context_prefix`
mechanism) — the fallback, not the default.
- The original conversation is immutable after the cut (ADR 0174's branch
  semantics preserved); the fork records its parent for navigation.

### 8. Agent adapter seam

Per-agent behavior lives in a registry of adapters, never in scattered
`match agent_id` arms. An adapter provides:

- **Notification preprocessing**: `1:1` rewrite, `drop`, or `1:N` expansion of
  incoming ACP `SessionUpdate`s before journal enqueue.
- **Ext-method translation**: agent-specific `session/request` ext methods are
  translated into synthetic *standard* notifications/events. Translation is
  non-recursive: synthetic notifications never re-enter the adapter pipeline.
- **Environment and command resolution**: per-agent env vars, binary
  discovery, and native permission-mode strings.
- **Turn-boundary hook**: invoked at terminal events for adapter-local
  bookkeeping (e.g. flushing subagent transcripts).

The seam sits at the actor's notification reception point, upstream of the
journal.

### 9. Visibility contracts

- **Subagents**: adapters map agent-specific subagent activity onto one
  agent-agnostic `subagent_update` envelope carrying a sub-session id, title,
  status, and (optionally) a transcript reference. Sub-sessions activate the
  dormant `ConversationRelationship::Subagent` and render as inline bubbles in
  the parent transcript. Unknown ACP `SessionUpdate` variants are counted and
  logged by the journal catch-all — never silently dropped.
- **Usage**: `PromptResponse.usage` (and per-update deltas where agents
  provide them) flows into session-state frames with a context-window
  indicator; it is never persisted into transcript events.
- **Always-allow memory**: `agent_permission_rules` and
  `AgentStore::allow_always`/`is_allowed` become the runtime's permission
  authority. Matchers are keyed by (project, agent, tool **kind**) — kind
  granularity only; matchers and analytics never carry prompt content, file
  paths, or file contents.

### 10. Persistence hygiene

Raw tool IO (`raw_input`/`raw_output`) lives in live frames only, never in
persisted session events. Non-terminal tool-call updates coalesce: one
persisted row per tool call at terminal status. Reloaded transcripts render
tool results from structured content. Persisted session events therefore grow
with runs, not notifications.

### 11. Terminal durability

Terminal transcripts are append-only log files at `WorkspaceService`-managed
paths with validated terminal ids (never raw paths; not SQLite blobs). Reads
prefer the live in-memory buffer, falling back to the log file after restart
or eviction. Stop/cancel kills a conversation's terminals by session before
cancelling the ACP prompt.

### 12. Web event-application contract

One reducer applies session events for live streaming, history load, and
cursor replay. It performs id-dedupe (events are applied at most once by id)
and stuck-tool flush (on a terminal event, any tool calls still in a
non-terminal state are finalized). Application is frame-budgeted: a batch of
replayed events applies within a bounded number of render frames.

## Consequences

The composer never dead-locks against an active run; sends enqueue or steer.
Optimistic bubbles make perceived latency independent of server-side SQLite
and git checkpoint work (which moves off the prompt critical path). Stop
converges the UI from one typed terminal event. Fork behavior becomes
decidable and provider-native history survives where agents support it.
Adapters isolate agent quirks, letting subagent visibility, permission memory,
and usage work uniformly. Terminal history survives restarts; the event table
stops growing per notification; streaming markdown cost is bounded by the tail
block. Costs: more event/frame types to version, a queue table to drain
correctly at turn boundaries, and adapter tests per supported agent. Each
contract lands through its #87 sub-issue with Red → Green → Refactor and the
full check suite green.
