# ADR 0205: Durable wake-driven workspace event delivery

## Status

Accepted

## Context

Workspace events are durable, globally ordered metadata records in SQLite. Live
SSE consumers currently discover new records by polling SQLite every 150
milliseconds. Replacing that polling loop requires a process-wide wakeup
contract, but an in-memory channel must not become another payload store or make
an uncommitted event observable.

## Decision

The process's shared `AgentStore` owns one `WorkspaceEventBus`. The bus is a
Tokio latest-value watch channel containing only the greatest committed
workspace-event cursor. `AgentStore` initializes it from
`MAX(workspace_events.id)` after schema initialization and before startup
recovery writes.

Every workspace-event writer publishes its inserted cursor only after SQLite
has committed the corresponding write. An autocommit insert publishes after the
statement succeeds. A multi-write transaction carries its newest inserted
cursor across the transaction boundary and publishes only after `commit()`
returns successfully. A rollback or failed commit publishes nothing. Publication
keeps the maximum cursor, so delayed concurrent publishers cannot move the
visible value backward.

SQLite remains the sole source of payloads and ordering. The bus is only a
wakeup hint, and consecutive publications may coalesce. A consumer subscribes
before its final catch-up query, replays ordered durable pages after its own
cursor, and treats the watched value only as evidence that another catch-up may
be needed. A late subscriber immediately observes the latest committed cursor.
Consequently, coalesced or missed notifications cannot omit durable events.

The bus owns no worker or queue. Runtime shutdown drops the shared store and
sender; channel closure releases blocked subscribers, which then stop with the
owning Runtime. Existing REST and SSE event payloads, event IDs, cursor inputs,
and replay semantics do not change.

## Consequences

Live consumers can wait without continuously querying SQLite, while reconnect
and recovery continue to use durable cursors. Wakeup memory is constant and a
slow consumer does not block writers or other consumers. Consumers must always
replay SQLite rather than interpreting a watched cursor as an event payload,
and delivery code must retain a recovery path for notification loss or channel
closure.
