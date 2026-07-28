---
type: ADR
id: "0206"
title: "Typed Composer catalog and structured draft"
status: accepted
date: 2026-07-28
---

## Context

The Composer is currently a single editable string. A run starts from
`POST /sessions/:id/runs` with `StartRunRequest { message: String }`, and the
Session actor dispatches that string as one ACP text content block. There is no
structured representation of what the user attached or invoked:

- ACP `available_commands_update` is stored verbatim as opaque JSON, projected
  last-write-wins through `GET /sessions/:id/state`, and the browser keeps only
  each command's `name` and `description`. Every other standard field is
  discarded.
- The `/` menu is triggered by `prompt.startsWith('/')` and filtered by
  substring on the name. Files and directories are inserted as relative `@path`
  text via the flat Project path picker. Skills are not represented at all.
- The Composer draft is a plain string in `sessionStorage`, keyed by Session
  ID (ADR 0191).

This loses item identity, source, scope, and the selected path the moment names
collide or a catalog changes. Files, commands, and user-invocable capabilities
have different semantics but collapse into one undifferentiated slash list, and
a generic ACP client cannot tell a control command from a skill by parsing the
command list. Issue #10 defines the intended interaction model (`@` context, `/`
Agent and Session commands, `$` capabilities, a global palette, and a
discoverable `+` menu) and requires this cross-cutting architecture to be
accepted before implementation.

## Decision

Introduce one server-owned **typed Composer catalog** that projects every
user-facing Composer item, a **structured draft** of ordered typed segments, and
**server-owned invocation** that resolves opaque browser-submitted IDs against
the current Session execution context. The catalog is a new cross-cutting
abstraction; it does not replace ACP and it is not a second copy of the provider
command list.

The catalog is named the **Composer catalog** to avoid collision with the
process-wide `AgentCatalog` from ADR 0196, which is the dynamic registry of
agent executables and adapters and is unrelated to per-Session command and
capability availability.

### Item identity and opaque IDs

Identity is `(kind, opaque server-issued item ID)`, never display name. The
server mints opaque, stable, unguessable IDs scoped to the Session execution
context, for example `cmd:…`, `ctx:…`, and `cap:…`. The browser receives only
opaque IDs and safe display metadata; it never receives provider method names,
invocation templates, private payloads, absolute paths, or executable content.

Two items may share a display name; both remain visible and resolve only by
their distinct opaque IDs. `/name` and `$name` may coexist because they are
different kinds. Display order, ranking, and selection never depend on parsing
the visible label.

### Kinds and scopes

Capability and command items use:

```rust
enum ComposerItemKind {
    Command,
    Skill,
    PluginAction,
    ProviderApp,
}

enum ComposerItemScope {
    Session,
    Project,
    User,
    Bundled,
    Plugin,
}
```

Context references use a parallel `ComposerContextKind` that starts with `file`
and `directory` and may later add `git-diff`, `terminal-selection`,
`session-turn`, and `diagnostics`. Each later kind requires its own bounded
size/count limits, authorization, stale behavior, and tests before it ships; it
does not become a stable part of the contract until then.

### Browser-visible snapshot contract

The browser receives one concrete, stable projection. Field names and types are
fixed by this ADR; only the provider invocation it resolves to stays
server-only.

```rust
struct ComposerCatalogSnapshot {
    conversation_id: String,
    revision: u64,
    items: Vec<ComposerItem>,
    contexts: Vec<ComposerContextMeta>,
}

struct ComposerItem {
    id: String,
    kind: ComposerItemKind,
    name: String,
    description: Option<String>,
    source_label: String,
    scope: ComposerItemScope,
    input_hint: Option<String>,
    enabled: bool,
    disabled_reason: Option<String>,
}

struct ComposerContextMeta {
    id: String,
    kind: ComposerContextKind,
    display: String,
    enabled: bool,
    disabled_reason: Option<String>,
}
```

`source_label` and `scope` are the only provenance the browser needs to render a
collision-safe badge such as "Claude command", "Project skill", "User skill", or
"Plugin action". The per-item `revision` is removed from the browser item: the
snapshot carries one `revision` for the whole catalog, and every item and
context meta in that snapshot shares it.

### Structured submit envelope and state hydration

`StartRunRequest` is extended from `{ message: String }` to carry the typed
draft. Plain text remains valid: a request with no segments and no item is
exactly today's prompt.

```rust
struct StartRunRequest {
    message: Option<String>,
    item_id: Option<String>,
    catalog_revision: Option<u64>,
    segments: Option<Vec<ComposerSegment>>,
}
```

`message` alone, or `segments` of only `Text`, is a plain-text prompt. A request
that carries `item_id` or any non-text segment must also carry
`catalog_revision` and is resolved and revalidated before dispatch.

State hydration adds one field to the `GET /sessions/:id/state` projection:

```rust
struct SessionComposerState {
    catalog: ComposerCatalogSnapshot,
}
```

The catalog snapshot replaces nothing in the existing projection; it is
additional state computed from the same Session event journal that already
produces `available_commands`.

### Catalog snapshot event

Catalog changes are announced through the existing Project-wide workspace-event
stream as a new full-snapshot event kind, conversation-scoped:

```rust
struct ComposerCatalogSnapshotEvent {
    conversation_id: String,
    revision: u64,
    snapshot: ComposerCatalogSnapshot,
}
```

The event **carries the safe browser snapshot** (items, context metadata,
revision); it does not merely invalidate. The browser replaces its local
snapshot wholesale with the latest one it receives. The payload contains only
the safe browser-visible fields above — never provider invocation templates,
private methods, absolute paths, or executable content. See *Catalog snapshot
delivery* below for how this event relates to the existing cursor-wakeup stream.

### Stable error response codes

Submit-time resolution failures return stable, machine-readable codes so the
browser can react without parsing prose. Provider invocation payloads stay
server-only; the codes describe only the resolution outcome.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `composer_stale_revision` | 409 | Submitted `catalog_revision` is behind the Session's current revision; refresh the snapshot and retry without dispatching. |
| `composer_item_missing` | 404 | The submitted `item_id` is not present in the current catalog. |
| `composer_item_disabled` | 409 | The item exists but is disabled or unavailable in this execution context (`disabled_reason` is returned). |
| `composer_item_unsupported` | 422 | The Agent/adapter does not advertise a reliable invocation for this item kind; no guess is made. |
| `composer_context_outside_project` | 403 | A context reference failed `WorkspaceService` containment or Session/worktree ownership. |
| `composer_context_over_limit` | 413 | A context reference or the whole draft exceeds its type-specific size or count bound. |
| `composer_context_stale` | 409 | A context reference resolved at an older revision is no longer available even though the catalog revision matched. |

`composer_stale_revision` and `composer_context_stale` are distinct on purpose:
the first means the whole catalog moved; the second means one reference went
stale on its own merits (a file deleted, a turn removed, a terminal closed).
Both block dispatch rather than dropping or approximating the segment.

### Catalog revision and snapshot semantics

The catalog is server-owned and scoped to the Session execution context: its
Project, worktree path, and runtime owner (ADR 0197). Availability is projected
from the live ACP connection and trusted adapter metadata inside that context,
never from a browser filesystem scan.

A catalog is a **full snapshot with a monotonically increasing revision**.
Updates replace the whole snapshot:

- ACP `available_commands_update` replaces the `Command` portion and advances the
  revision, preserving the existing last-write-wins projection semantics.
- A trusted adapter skill update replaces the relevant skill portion and
  advances the revision.
- Workspace and runtime events **carry a new full catalog snapshot with its new
  revision** as a conversation-scoped `ComposerCatalogSnapshotEvent` (see
  *Catalog snapshot delivery*). There is no incremental delta-merge protocol:
  the browser replaces its local snapshot with the latest full snapshot it
  receives. This mirrors how ACP command updates already work and avoids
  divergent client/server merge state.

Revisions are monotonic within a Session. Refreshing the catalog must not
disconnect, restart, or interrupt an active Session actor (ADR 0204); it only
publishes a new snapshot. Switching the selected browser Session changes only
the visible catalog and never mutates another Session's catalog.

### Durable and transient ownership

| State | Owner | Durability |
| --- | --- | --- |
| Catalog snapshot and its revision (per Session) | Server, Session execution context | Durable: derived from the Session event journal the same way `available_commands` is today, so it is reconstructed identically after reconnect or server restart. |
| Opaque-ID → invocation mapping | Server only | Durable server-side state; never sent to the browser. An opaque ID resolves to the same `ComposerInvocation` regardless of which client submits it. |
| Context reference records (file/dir, later kinds) | Server, resolved at submit | Durable where the underlying source is durable (Project files, stored turns); transient where the source is (a live terminal selection). The record's existence and bounds are always rechecked at submit time. |
| Per-Session browser draft (ordered segments) | Browser, keyed by Session ID | Transient browser state (ADR 0191); never authoritative. The server revalidates every segment it receives. |

### Collision-safe identity and revisions across reconnect and restart

Opaque IDs and revisions are constructed so that a restored draft can never
resolve to a different item than the one the user selected:

- **Opaque IDs are namespaced by kind and bound to a stable provider/source
  identity, not to a row position or display name.** An ID encodes its kind
  (`cmd:`, `ctx:`, `cap:`) and a stable digest of the provider/source identity
  (for example the ACP command name plus owning Agent, or a Project-relative
  path). Two distinct capabilities never share an ID, and the same capability
  keeps the same ID across reconnect and server restart as long as its
  provider/source identity is unchanged.
- **Revisions are monotonic per Session and advance only on a committed
  snapshot change.** A revision is never reused within a Session. Because the
  snapshot is derived from the durable Session event journal, the revision the
  browser holds after reconnect is the same revision the server holds for that
  journal state.
- **A draft reference is interpreted only as "the item with this opaque ID, as
  of this revision."** On submit the server resolves the ID against the current
  catalog. If the ID is absent, the response is `composer_item_missing` or
  `composer_context_stale` — never a silent substitution to a same-named item.
  If the provider/source identity behind an ID genuinely changed, the ID no
  longer resolves and the user must re-select; the draft never silently
  re-targets a different capability, file, or command.
- **Cross-Session and cross-Project IDs are rejected.** An ID minted for one
  Session execution context is not valid in another; submit-time ownership
  checks return `composer_context_outside_project` or `composer_item_missing`
  rather than resolving a foreign ID.

### Hydration, reconnect, and Session switching

Creating, loading, or reconnecting a Session hydrates the latest catalog for
that Session from Session state, the same path used today for
`available_commands`. A remote or runtime-owned Session performs catalog
discovery at its runtime owner; the browser never substitutes its own local
filesystem view. Because both snapshot and browser draft are interpreted as
"(opaque ID, revision)" and revalidated at submit, restoring a draft after
reconnect can never dispatch a different item than the user selected.

### Catalog snapshot delivery

Catalog snapshots are delivered over the **existing Project-wide workspace-event
stream** (the single multiplexed SSE channel from the event model), not a new
transport. The stream already carries typed, durable event rows, each scoped
with optional `project_id`, `conversation_id`, and `run_id` and ordered by a
monotonic cursor. The catalog reuses that infrastructure:

- A catalog change is published as a `ComposerCatalogSnapshotEvent` row (see
  above) **scoped to its `conversation_id`**. The browser filters catalog
  events to the active Session, so one Session's snapshot never appears as
  another's.
- The event **carries the safe browser snapshot** in its payload — items,
  context metadata, and the new revision — and the browser replaces its local
  snapshot wholesale. It is not a bare invalidation that forces a separate
  `GET /sessions/:id/state` refetch: the snapshot is in the event.
- This is consistent with how the stream already works. The `WorkspaceEventBus`
  publishes only a latest-value cursor wakeup (it owns no payload queue); the
  durable SQLite log is the authority, and consumers replay ordered event rows
  from their own cursor. The catalog snapshot event is simply another
  conversation-scoped row in that log, delivered by the same cursor-driven SSE
  path as session/run/file/Git events.
- On reconnect, a browser first reads the durable current cursor, then replays
  catalog snapshot rows from its own cursor, so it converges to the latest
  committed snapshot for its Session without missing an update. A stale cursor
  can never lower the visible revision, because revisions are monotonic per
  Session and the durable log is authoritative.

`GET /sessions/:id/state` remains the initial hydration source for a Session
that has not yet subscribed to the stream; the event stream is the live update
path. Both carry the same safe snapshot.

### Structured draft segments

The draft is an ordered list of typed segments, persisted per Session and keyed
by Session ID as required by ADR 0191:

```rust
enum ComposerSegment {
    Text { text: String },
    ContextRef { id: String, revision: u64 },
    CapabilityRef { id: String, revision: u64 },
}
```

A `ContextRef` or `CapabilityRef` carries the opaque catalog ID and the
**revision it was selected against**. Copying the Composer produces a readable
plain-text fallback such as `@src/main.rs` or `$skill`. Pasting that fallback is
ordinary text until the user re-selects a catalog result; Kubecode never treats
a pasted name as a server-issued ID. Plain-text-only prompts remain fully
backward compatible: a draft with no references is exactly today's string.

### Submission and server-owned invocation

A submit or invoke request carries the Session ID, the catalog revision the
draft was built against, an optional item ID, user arguments, and the ordered
segments. It never carries a provider method, invocation template, absolute
path, shell text, or executable payload.

The server resolves the item to a private invocation, which it never sends to the
browser:

```rust
enum ComposerInvocation {
    AcpPromptTemplate { template: String },
    AcpPrivateMethod { method: String, payload: Value },
    ProviderStructuredInput { adapter_kind: String, payload: Value },
    HostAction { action: String },
}
```

Resolution and revalidation happen server-side at submit time. Validation has two
distinct layers, which the implementation keeps separate:

1. **Catalog-revision validation.** The submitted revision is checked against the
   Session's current catalog revision. A mismatch returns a stale-revision
   response that lets the browser refresh its snapshot **without dispatching the
   wrong item**. This layer governs which item the user meant.
2. **Per-reference checks.** Each resolved context reference is independently
   revalidated for Session and Project ownership, scope and availability,
   `WorkspaceService` containment, type-specific size and count bounds, and its
   own staleness. A reference can be unavailable even when the catalog revision
   still matches. Disabled, ambiguous, or unavailable items are rejected, not
   guessed.

The ordered-segment contract is preserved across both layers: the server
revalidates each segment in place and only dispatches when every segment
resolves, so an unavailable chip blocks submission rather than being silently
dropped or approximated.

### Standard ACP versus trusted private adapter metadata

The boundary between ACP, private adapters, host actions, and plugins is
explicit:

- A standard ACP command stays a `/` `Command` item. The server preserves all
  useful standard ACP command fields, including input hints when supplied. It
  never infers `kind` from a command name or description.
- A command is reclassified as a `Skill` (or other capability kind) **only** when
  its owning adapter supplies trusted typed metadata connecting the ACP entry to
  a skill or capability identity. Claude side questions remain a
  capability-gated `/btw` command dispatched through the private
  `_claude/side_question` extension (ADR 0199); Codex prefers structured skill
  input with text fallback only when the adapter confirms it is unambiguous;
  OpenCode exposes a capability row only when its adapter advertises a reliable
  manual-invocation contract. Provider differences appear as source badges,
  input hints, availability, and invocation behavior; Kubecode never claims
  unsupported features are equivalent (ADR 0198) and never invents commands or
  capabilities for an Agent that does not advertise them (ADR 0199).
- Unknown ACP or private extension metadata is retained (ADR 0166) but is not
  executable without a registered adapter decoder.
- When a text-fallback skill is ambiguous and the provider offers no qualified
  invocation, both ambiguous rows are disabled with an explanation rather than
  one being silently chosen.

### Host actions and the global palette

Kubecode application actions (open Settings, create a Session, toggle a panel)
live in a small typed **host action registry**, separate from ACP commands and
never sent as prompts. The global command palette consumes host actions, the
current Session's commands, and trusted capabilities, grouped and labeled by kind
and source. Selecting an Agent command or capability when no compatible writable
Session is active shows a disabled reason rather than implicitly choosing
another Session.

### Plugins are out of scope

A future plugin manifest may contribute tools, skills, UI panels, and
user-facing actions, but only contributions with an explicit title, scope,
permission declaration, and invocation contract enter the typed catalog or global
palette. Plugin discovery, install, update, trust, sandbox, permissions,
credentials, enable/disable policy, and lifecycle are a separate management
surface and require their own accepted ADR before any runtime is implemented.
This ADR introduces no plugin runtime.

### Security and privacy

- All context resolution goes through `WorkspaceService` using Project and
  Session IDs and validated relative paths, with `ensure_contained_or_same` and
  the worktree containment gate (ADR 0191, ADR 0197). The server rechecks
  containment, Session ownership, item availability, and catalog revision at
  submit time.
- Context references are bounded by type-specific size and count limits.
- The browser never receives an absolute Project, worktree, skill, or plugin
  path after registration.
- Analytics record only coarse item kinds, Agent IDs, picker outcome, latency,
  and bounded counts. They never include provider credentials, prompt content,
  filenames, file contents, skill names, plugin names, or absolute paths.
- Unknown metadata is preserved but not executable without a registered decoder.
- Plugin secrets, when plugins exist, stay in the host secret store and never
  enter a plugin sandbox or analytics payload.

## Affected API and service ownership boundaries

| Boundary | Change |
| --- | --- |
| `POST /sessions/:id/runs` (`StartRunRequest`) | Extended to `{ message, item_id, catalog_revision, segments }`; plain text remains valid. The server resolves opaque IDs and returns the stable `composer_*` error codes on failure. |
| `GET /sessions/:id/state` | Adds a `SessionComposerState { catalog }` hydration field projecting the `ComposerCatalogSnapshot` (items, context metadata, one revision) alongside the existing `available_commands` projection. |
| Session actor / `SessionCommand` | Owns the durable catalog snapshot and revision for its execution context; refresh publishes a new full snapshot and never restarts or disconnects the actor (ADR 0204). Holds the server-only opaque-ID → `ComposerInvocation` mapping. |
| Workspace-event stream | Carries a conversation-scoped `ComposerCatalogSnapshotEvent` with the safe full snapshot payload and monotonic revision; no delta merge. Cursor-driven SSE and durable SQLite log semantics are unchanged. |
| `WorkspaceService` | Remains the sole context-resolution boundary: containment, worktree validation, and bounded per-kind size/count checks, returning `composer_context_outside_project` / `composer_context_over_limit` (ADR 0191, ADR 0197). |
| Browser draft | Transient, keyed by Session ID (ADR 0191); interpreted as `(opaque ID, revision)` and fully revalidated at submit. |
| Bundled adapters | May advertise trusted typed skill/capability metadata and resolve selection to provider-native behavior; Claude side questions stay capability-gated (ADR 0199). |
| Host action registry | New, small, typed registry consumed by the global palette; never an ACP command and never a prompt. |
| Analytics | Coarse kinds, Agent IDs, picker outcome, latency, bounded counts only. |

## Consequences

- Files, Agent commands, and user-invocable capabilities get distinct, typed
  Composer surfaces that preserve identity through name collisions and catalog
  changes.
- The browser holds only opaque IDs and safe metadata; every filesystem and
  capability identity is resolved on the server within the Session execution
  context.
- Catalog revisions make staleness explicit: a stale revision refreshes without
  dispatching the wrong item, while each context reference is still checked on
  its own merits.
- Standard ACP command availability stays authoritative; private adapter
  extensions are opt-in and never guessed from names.
- The change is additive and documentation-only in this phase. Implementing the
  catalog projection, structured draft submission, adapters, `$` picker, global
  palette, and richer bounded context proceeds phase by phase under issue #10,
  each with its own tests. Plugin runtime remains deferred to a separate ADR.
