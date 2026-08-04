---
type: ADR
id: "0208"
title: "Path-scoped watched Project invalidation"
status: accepted
date: 2026-08-02
---

## Context

The Explorer lazily caches each expanded Project directory, but the current
`file_changed` workspace event carries several ad hoc payload shapes and causes
every expanded directory to reload. Only Kubecode API handlers emit that event.
Files changed by an Agent, a terminal, Git, or another host process can therefore
remain stale until a manual refresh.

ADR 0170 requires a lazy Project tree, ADR 0172 makes durable workspace events
the live browser signal, and ADR 0205 makes SQLite the sole event payload and
ordering authority. Native filesystem notifications are lossy hints: they may be
duplicated, reordered, coalesced, overflowed, or unavailable. They cannot become
a second event log or a source of file contents. The watcher also observes
absolute host paths internally, while the Project API may expose only validated
Project-relative paths.

## Decision

Add the Rust `notify` crate and use its recommended recursive watcher behind
`WorkspaceService`. `WorkspaceService` owns every watch registration, the native
callback bridge, coalescing worker, retry state, and shutdown lifecycle. The
exact compatible crate version is selected and locked by the implementation;
clients do not depend on a native backend or `notify` type.

### Event contract

`file_changed` is a Project-scoped invalidation hint. Its only accepted payload
is:

```ts
type FileChangedPayload = {
  paths: string[]
  full?: boolean
}
```

Producers emit one of two canonical forms:

- a scoped invalidation, `{ "paths": [...] }`, containing between 1 and 256
  distinct paths; or
- a full invalidation, `{ "paths": [], "full": true }`.

Producers omit `full` for a scoped event and never emit `full: false` or combine
`full: true` with paths. Consumers treat a malformed payload, an invalid path,
or more than 256 paths as a full invalidation. `{ "paths": [] }` is malformed,
and consumers fail closed to a full reconciliation; the only canonical
empty-path form is `{ "paths": [], "full": true }`. There is no long-lived
legacy `path`, `from`, or `to` form; explicit API producers and browser
consumers move to this contract in the same rollout. This ADR supersedes only
ADR 0205's statement that existing `file_changed` payloads remain unchanged.
ADR 0205's SQLite payload and ordering authority, commit-before-publication,
durable cursor, replay, and other ordering and durability decisions remain in
force.

Each path identifies an affected entry, not an absolute directory to enumerate.
Create, write, and delete include that entry. Rename includes both the old and
new entry, including for a move between directories. A consumer marks each
entry's loaded parent stale. If the path itself or any descendant has cached
directory state, that state is evicted or marked stale because the entry may
have been removed, moved, or changed kind. A full event marks every loaded
directory for that Project stale. Request generations prevent a response started
before invalidation, eviction, Project change, or unmount from restoring stale
state.

`file_changed` also marks that Project's Git projection dirty because an ordinary
filesystem change may alter status. A watcher batch containing ordinary Project
paths emits one `file_changed`; `.git` activity in the same batch does not add a
duplicate `git_changed`. A batch containing only paths whose first component is
exactly `.git` emits one `git_changed` with `{}` and does not invalidate Files.
`.gitignore` and names merely beginning with `.git` are ordinary Project paths.
No `.git` metadata path is included in a browser payload.

A full `file_changed` reconciles both Files and Git. Existing explicit Git API
events remain `git_changed`, including their current safe action metadata. An
explicit Git operation that can change working-tree entries also emits a scoped
or full `file_changed` for those entries. Explicit create, write, delete, and
rename handlers publish the canonical `file_changed` immediately after their
mutation succeeds. Watcher echoes may duplicate these hints and are harmless;
the watcher never replaces explicit invalidation.

### Relative-path boundary

Only `WorkspaceService` converts a native path. For the exact Project watch
registration that produced the callback, it:

1. requires an absolute native path below that Project's registered canonical
   root and strips that root;
2. rejects a prefix, root, parent, current-directory, empty, NUL-containing, or
   non-UTF-8 relative component, and rejects the private top-level `.state`
   directory and every descendant of it;
3. checks the target, or the nearest existing ancestor for a removed target,
   against the same containment and escaping-symlink rules used by Project file
   APIs; and
4. serializes normal components with `/`, preserving their case and Unicode.

The Project root itself is represented by a full invalidation, never `""` or
`"."`. Paths are deduplicated and sorted by their serialized value before
publication. If an event contains a path that cannot be classified safely, the
complete Project batch becomes full rather than dropping only that path. A
native rename classified as a rename must yield both validated old and new
paths; a missing or invalid side makes the batch full.

Nested registered Projects have independent watch registrations. The same host
change may therefore produce one independently scoped event for each containing
Project, but neither event reveals either Project root.

### Bounded callback and coalescing

Native callbacks perform no async work and never wait for the Runtime. Each
Project registration has a monotonically increasing generation and an atomic
overflow flag. A callback copies at most 256 native paths into a compact record
containing Project ID and generation, then uses `try_send` on one process-wide
channel with capacity 1,024 records. More paths in one native event, native
backend overflow, or a full channel sets that Project's overflow flag. Queue
closure during shutdown drops the callback after recording no new work.

One `WorkspaceService` worker drains the channel and keeps at most 256 normalized
paths plus Files-dirty, Git-dirty, full, first-seen, and last-seen state per
registered Project. It deduplicates paths and may remove descendants only when
the retained ancestor already requires that cached subtree to be invalidated.
The 257th accumulated path changes the Project batch to full and clears its path
set. Every backend error produces a full invalidation; an error that means the
native watch is no longer usable also transitions the registration to
unavailable.

The worker flushes a Project batch after about 250 milliseconds without a new
accepted record, or 2 seconds after the batch's first record, whichever occurs
first. Continuous activity therefore cannot postpone publication indefinitely.
Overflow flags are inspected independently of channel receipt and force a full
batch on the worker's next cycle, so saturation cannot also discard its recovery
signal. A flag or pending batch is cleared only after the durable workspace event
commit succeeds. A persistence failure retains the Project as full-dirty and
retries no faster than the next 2-second maximum-flush boundary.

Coalescing happens before persistence. A flushed `file_changed` or `git_changed`
is appended to the existing SQLite workspace-event log and only then advances
ADR 0205's `WorkspaceEventBus` cursor. Raw callback records, timers, overflow
flags, and pending path sets are process-local and non-durable. They are neither
SSE payloads nor delivery acknowledgements.

### Project and watcher lifecycle

After SQLite Projects and the workspace-event append sink are available, but
before the HTTP listener accepts requests, startup asks `WorkspaceService` to
watch every registered Project. Project registration first commits the Project,
then installs its watch. A watch failure does not roll back or hide an otherwise
valid Project. Successful Project unregister invalidates the registration
generation, cancels retry state, drops its native watcher, and discards only
not-yet-flushed pending batch state; it removes only Kubecode metadata and
never Project content. Registration, callback, and unregister commands share
one worker: a synchronous durable append already in progress finishes before a
queued unregister is processed, after which unregister fences the generation.
Late callbacks carrying an inactive generation are ignored.

Watch installation failure is an explicit supported state. It is recorded as a
path-free operational diagnostic, while explicit API invalidations and the
always-available manual refresh continue to work. `WorkspaceService` retries a
registered unavailable Project after 1, 2, 4, 8, 16, 32, and then 60 seconds,
remaining at 60 seconds until success or unregister. A successful retry installs
the watch first and then publishes one full `file_changed`, closing the interval
during which external changes could not be observed. Runtime backend failure
uses the same full-invalidation and retry path. This ADR adds no watcher-health
field to Project payloads; implementation diagnostics must not include a Project
path in analytics.

Orderly Runtime shutdown first prevents new Project lifecycle operations, drops
native watch registrations, closes the callback sender, drains accepted records,
flushes pending batches, and joins the coalescing worker. A crash may lose raw or
pending hints, which is why reconnect reconciliation is mandatory.

### Reconnect and manual recovery

Durable SSE replay remains unchanged: each persisted invalidation has one global
monotonic ID, clients replay SQLite after their own cursor, and the process-local
watch cursor remains only a wakeup. Disk and Git, not the watcher or event
payload, are authoritative.

Whenever the global SSE connection opens, including its initial open and every
reconnect, the browser schedules one full reconciliation for each Project for
which it retains loaded Explorer or Git state. It marks all loaded directories
stale and Git dirty, independent of which durable events replayed. This closes
crash, watcher-unavailable, native overflow, and disconnect gaps without
inserting another workspace event or replaying arbitrary paths. Reconciliation
uses the same Project and request-generation guards as ordinary invalidation.

Manual refresh is always enabled. It bypasses event debounce, marks all loaded
directories stale, and requests authoritative Files and Git projections. It does
not depend on watcher health and does not restart the watcher. Failed refreshes
remain recoverable and retain stale state rather than presenting old data as
current.

Watcher events contain no file contents, mutation instructions, absolute paths,
provider data, prompts, or credentials. Project-relative paths are application
event data needed for invalidation and must not be copied into analytics.

## Consequences

- External changes become bounded durable invalidation hints while Files and Git
  remain authoritative pull projections.
- A burst uses bounded callback and per-Project memory and produces at most one
  coalesced Files event and, only for Git-only activity, one Git event per flush.
- Loaded directory parents can refresh selectively; overflow and uncertain
  classification deliberately trade precision for a complete reconciliation.
- Watcher absence cannot make Project registration or explicit file operations
  unavailable, and retry, reconnect, and manual refresh close observation gaps.
- Duplicate explicit and native hints are expected, so browser scheduling and
  request-generation guards remain necessary.
- The `notify` dependency and a process-owned worker add lifecycle complexity to
  `WorkspaceService`, but do not add a filesystem authority, event stream, or
  persistent VFS.
