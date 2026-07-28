# ADR 0203: Batched Agent Runtime events

## Status

Accepted

## Context

ACP adapters may emit a notification for every small text or thinking fragment.
Persisting each fragment independently writes Session, run, and workspace event
rows and makes every SSE consumer repeat the same scheduling overhead. The
fragment boundary has no user-visible meaning, but the resulting write and
render amplification can make an otherwise local Session unresponsive.

## Decision

Each connected Agent Session owns a `SessionUpdateJournal`. It concatenates
adjacent text or thinking updates only when run, event kind, provider message
identity, and metadata match. Pending streaming updates flush after 33
milliseconds measured from the first fragment in the fixed window; later
fragments never extend the deadline. A bounded channel applies backpressure to
ACP notification producers. Pending updates also flush before every semantic
event, permission request, elicitation, run completion, connection shutdown, or
provider-history checkpoint.

One `AgentStore` transaction writes every normalized update in a flushed window,
including each Session event and its optional run/workspace projection. A flush
is a persistence fence: its caller observes any write failure. Shutdown stops
new producers, drains accepted updates, and joins the journal worker before the
Session actor exits. Existing REST and SSE representations, durable sequence
ordering, reconnect cursors, and reconstructed text remain unchanged. Provider
fragment boundaries are not a persistence contract.

## Consequences

Streaming remains incremental while SQLite transaction and SSE event counts are
bounded by time and semantic identity rather than provider tokenization. Tests
must verify exact text reconstruction and ordering across text, tools,
permissions, elicitations, completion, cancellation, failure, hydration, and
reconnect. Concurrent Session journals must remain isolated, and a failed batch
must roll back all three durable projections.
