# Abstractions

## Runtime client

A Runtime client observes and controls the same Project, Session, Team, file,
Git, and terminal resources as the browser. Local-managed, SSH-managed, and
HTTPS-attached connections differ in process and transport ownership, not in
their application model or API. API-only local runtimes use an ephemeral
loopback port and a bearer token delivered over standard input; the client must
never infer authority from a server filesystem path returned in JSON.

The typed `GET /api/v1/runtime/status` client route reports only active and idle
Session actor counts, the Runtime-owned warm actor limit, the latest committed
workspace-event cursor, and whether workspace-event delivery is available. The
route inherits the generic base path and the same bearer boundary as every
other client route in API-only mode. Delivery availability describes the
Runtime capability, not whether a particular client currently has an SSE
connection. The response deliberately excludes Session identities, prompts,
provider payloads, credentials, filenames, file contents, executables, and
Project or arbitrary server paths.

Cluster schedulers such as Slurm are not Runtime connection modes. They remain
provider-native Agent skills that use the user's SSH configuration and native
scheduler commands, rather than a Kubecode scheduler service or persistence
model.

## Project

A Project is an application ID mapped to an absolute canonical server path.
`WorkspaceService` is the only layer allowed to translate the ID and a
browser-supplied relative path into a filesystem path. It rejects traversal,
escaping symlinks, and the private Kubecode state directory. Project entry
listings do not follow symbolic-link children; this keeps lazy Explorer reads
inside the registered root and prevents inaccessible or remote link targets
from expanding the access boundary. Directory enumeration runs on Tokio's
blocking pool so an unavailable mount or an operating-system authorization
prompt cannot consume the asynchronous HTTP executor.

Registering or importing a Project adds metadata to SQLite. Unregistering it
removes that metadata only; it never removes the Project directory or files.
Native local clients may submit a user-selected absolute path to the
Project-scoped authorization endpoint. `WorkspaceService` canonicalizes it and
accepts it only when it exactly matches that Project's registered root; the
response never exposes the stored root path.

Native rich-text clients may read a bounded binary preview through the Project
asset endpoint using only a Project ID and validated relative path.
`WorkspaceService` applies the same traversal, symlink, and private-state rules
as file reads and caps the response at 8 MiB. The endpoint never accepts or
returns an absolute server path and is not a general filesystem URL.

The `workspaces_enabled` preference controls whether new isolated Agent
Sessions may be created. It defaults to false and does not itself move or
delete existing execution directories.

Workspace migration is explicit and resumable. Each worktree requires a Merge,
Export patch, or Discard resolution. Active Agent runs prevent migration, and a
Git conflict leaves Workspaces enabled so the user can resolve it before
continuing.

## Agent Session and Agent Chat

An Agent Session owns an execution boundary: Project, cwd, shared/worktree
mode, and eventually its Files, Changes, Tasks, and Terminal resources. A
server-generated worktree path is private application state and is never
accepted as an arbitrary browser path.

An Agent Chat owns one provider conversation, transcript, configuration, and
run history inside that execution boundary. During the compatibility phase the
stored conversation is both the Agent Chat and its one-to-one Agent Session;
`agent_session_id` makes the boundary durable for an additive one-to-many
migration later.

An Agent Chat revision is an immutable hidden snapshot of the Chat before a
selected run. Editing, regenerating, or undoing truncates only the active
revision, resets its provider identity, and keeps the logical Session ID stable.
Earlier revisions remain read-only and navigable. An Agent Chat branch is still
an explicit visible Fork; it is not the implementation of message editing.
`recreated_context` is shown whenever Kubecode rebuilds provider context from
the durable timeline instead of using a native provider checkpoint.

A Team Session is a durable coordination boundary with one fixed Leader, a
dynamic set of teammates, a task dependency graph, member mailboxes, and an
explicit supervised lifecycle. A Draft passes through Starting and becomes
Active only after the user supplies its
goal, acceptance criteria, allowed installed Agents, and teammate/concurrency
budget. Every member owns an independent Agent Chat and provider Session.
Shared members use the Team cwd; an explicitly isolated member receives a
worktree and stores its base Git tree. Only the Leader may add members, review
plans/results, integrate accepted work, and author the final Team response.
The Leader may edit the workspace but can never be a concrete task assignee.

A Team mode has a requested value and an effective value. YOLO is Kubecode
policy language, not an Agent-native mode name. Its native permission profile
is an exact, versioned mapping owned by the runtime, while model, effort, fast
mode, and other non-permission configuration remain user-owned. A Team Mode
Fallback is the durable reason that a requested YOLO Team is effectively
Standard. A Member Permission Snapshot records whether Kubecode applied the
profile and the prior mode needed for restoration.

A Team mailbox message has a durable delivery lifecycle: pending, delivered,
acknowledged, failed, or cancelled. Delivered is a lease, not proof of receipt. Reading
Team context acknowledges the message; an expired unacknowledged lease is
retried up to the finite delivery limit. Delegation atomically assigns a task
and writes the recipient message. The scheduler wakes the recipient in its own
Agent Chat and respects the Team's maximum parallel-run setting. A Team
activity event is a structured coordination projection; it is not a replacement
for the member's Chat transcript.

A Team Lifecycle Operation is durable metadata for provisioning or disbanding.
It carries its target independently of Team/member foreign keys, attempt count,
retry time, diagnostic, and terminal result. The server supervisor owns
retries. Historical provider-cleanup records are completed without contacting
the provider and no new provider-cleanup operation is created.

A Team User Input Request is a durable Leader escalation with a title, prompt,
prior Team state, answer, and resolution time. While one is pending, the Team is
Needs Attention and teammate scheduling is paused. Resolution restores the
prior Active or Verifying state and enqueues the answer for the Leader.

A Team Task Attempt binds one concrete task assignment to one teammate and,
once awakened, one ACP run. It persists queued, running, missing-report,
submitted, completed, and failed states. Failures use a provider-neutral
classification while retaining the original diagnostic. A completed Agent turn
without a structured result receives one durable reminder; repeating that
condition fails the Attempt so the Leader can retry or reassign the task.
Cancelling a task waives its completion requirement and terminates its active
attempt and deliveries. Retrying failed or cancelled work creates a new
required scheduling opportunity while preserving prior Attempts as history.

A Team permission request is a durable projection of one Teammate ACP
permission callback, including the exact tool input and Agent-provided options.
It moves from `pending_leader` to either `resolved`, `waiting_user`, or
`cancelled`. Only the fixed Leader may resolve or escalate it; the user can
resolve it only after escalation. The ACP callback itself remains live until a
decision, cancellation, or Agent disconnect. In YOLO mode escalation is
disabled: the Leader must choose an advertised native option or the Team stops
for attention.

A Team Discriminator is a fresh, read-only Agent Session used only by YOLO
Teams. It cannot own tasks, edit implementation, or send arbitrary coordination
messages. It evaluates the Team goal and evidence against acceptance criteria
and submits one pass/reject verdict tied to a Git tree fingerprint. Rejection
cannot be overridden; a later pass requires a new round after the workspace
changes. The Discriminator does not count as a teammate or consume the
teammate budget. Read-only enforcement uses exact provider controls rather than
matching translated or display labels: Codex `read-only`, Claude Code `plan`,
and OpenCode `plan`.

An internal Team run is a normal persisted Agent run owned by the recipient's
Session, but its synthetic wake prompt is hidden from the browser timeline and
cannot retitle or branch the Chat. Agent output and interactive ACP events remain
visible so users can inspect and continue each teammate independently.

The `kubecode-team` MCP server is the cross-Agent control plane for bounded
member creation, task attempts, plan/result/permission review, independent
verification, explicit completion, and messaging. It does not replace
provider-native tools or subagents. ACP transport capabilities choose how it is
attached. HTTP-capable agents receive a tokenized streamable HTTP endpoint on
new, load, and resume; other agents retain the in-process bridge for new
sessions.

Teammate spawn accepts opaque Agent-native ACP mode/configuration IDs rather
than a Kubecode model abstraction. Teammate removal is a Leader-only,
local-first lifecycle transition: the ACP actor is disconnected, active
assignments return to pending, and Team membership plus the Kubecode Session
disappear immediately. Provider-native history and Project files remain
untouched. The Leader first discovers durable member IDs through
`team_list_members`, then invokes `team_remove_teammate`. The ordinary Session
API rejects teammate deletion before disconnecting its actor; the browser does
not expose that action. Deleting the fixed Leader disbands the Team with the
same local-first rule for every member.

## Turn checkpoint

A turn checkpoint stores optional before/after Git tree IDs for one run. Trees
are captured with a private alternate index, so staging remains user-owned.
Shared-workspace restoration requires an after-tree fingerprint match; a
mismatch is a conflict, not an overwrite. A legacy run without a complete
checkpoint cannot participate in an explicit safe file restore. Chat revision
creation remains available because it never changes Project files.

## Typed Composer catalog

A typed Composer catalog is a server-owned projection of every user-facing
Composer item for one Session execution context: its Project, worktree path, and
runtime owner. It separates `@` context references, `/` Agent and Session
commands, and `$` user-invocable capabilities instead of routing them through
one slash list (ADR 0206). Each item has a `kind` (`Command`, `Skill`,
`PluginAction`, or `ProviderApp`), a `scope`, a collision-safe source label, an
optional input hint, an enabled state with disabled reason, and a stable opaque
server-issued ID. Identity is `(kind, opaque ID)`, never display name; two items
may share a name and both remain visible, resolving only by distinct IDs.

The browser derives both the inline `$` picker and the Composer `+` capability
section from that same safe snapshot. `$`, `＄`, `¥`, and `￥` start discovery
only at the beginning of input or after whitespace; a full-width variant is
removed only after an explicit selection. Results rank exact name, prefix,
substring, subsequence, then description matches, with deterministic scope,
source, kind, name, and opaque-ID tie breaks. Same-name rows are never
deduplicated: kind, safe source, and localized scope remain visible on the row
and chip, while ambiguous duplicates stay disabled with a localized reason.
Other disabled or unsupported items, raw ACP commands, and unknown metadata
cannot enter this picker.

The catalog is a full snapshot with a monotonically increasing revision.
`available_commands_update` replaces the `Command` portion; a trusted adapter
skill update replaces the relevant skill portion; each replacement advances the
revision. Workspace and runtime events announce or carry a new full snapshot
with its revision, and the browser replaces its local snapshot wholesale; there
is no incremental delta-merge protocol. Refreshing the catalog never restarts or
disconnects an active Session. A remote or runtime-owned Session performs
discovery at its runtime owner; the browser never scans provider home
directories or substitutes its own filesystem view.

The current server persists the raw standard ACP snapshot and its safe catalog
projection atomically in the Session journal. A changed projection advances the
revision and appends one `composer_catalog_snapshot` row to the existing durable
workspace-event log; an equivalent projection does neither. Hydration reads the
latest safe journal snapshot, so process reopen preserves the exact revision and
opaque IDs. A durable revision high-water mark belongs to the Session row rather
than its rewindable transcript. The rewind transaction compares the retained
snapshot with the raw command and Session-lifetime context registry projection;
a mismatch emits exactly one reconciled full snapshot whose revision is greater
than every revision previously issued for that Session. Typed command resolution checks Project/Session
ownership, revision, ID, availability, and the authoritative raw snapshot in the
same transaction that creates the internal run, preventing a replacement from
interleaving between validation and dispatch eligibility.

The safe full snapshot is bounded separately to 256 items and 256 Session
context identities, including at most 64 trusted adapter contributions. The
context registry never evicts or truncates an existing identity when full.
Invalid or over-limit trusted source identities and item names are omitted
without truncating identity. Duplicate trusted identities and trusted `Command`
shapes without an implemented server resolver remain disabled, so they cannot
fall through to exact-name ACP command dispatch.

Provider invocation is server-only. The browser submits the Session ID, the
catalog revision the draft was built against, an optional item ID, arguments,
and ordered draft segments; it never submits a provider method, invocation
template, absolute path, or executable payload. At submit time the server first
validates the catalog revision (returning a stale-revision response that lets
the browser refresh without dispatching the wrong item) and then independently
revalidates each resolved context reference for ownership, scope, availability,
containment, type-specific size and count bounds, and staleness. Disabled,
ambiguous, or unavailable items are rejected rather than guessed.

File and directory selection first registers a normalized Project-relative path
against the already-authorized Session and receives a deterministic Session-local
opaque ID. Restoration marks every persisted reference stale and batch-validates
at most 32 references; one successful batch applies all availability changes and
at most one full catalog revision/event atomically. A foreign-Session or invented
ID has the same stale result because lookup is always keyed by Session and opaque
ID, never by a global ID oracle. Registration, validation, and submit all resolve
filesystem eligibility through `WorkspaceService`, including ancestor and final
symlink rejection. That filesystem preflight runs immediately before, but outside,
the AgentStore database mutex. The following immediate SQLite transaction repeats
all database-owned Session, Project, current and historical revision, ID, kind,
enabled, and scope checks before creating a run; filesystem state itself is not
claimed to be locked by SQLite. A failed structured-run preflight does not mutate
context availability, catalog snapshots, events, or runs.

Every structured request first applies the shared segment, reference, and
aggregate-text limits, then resolves its exact Shared or Session-owned worktree
execution root through `WorkspaceService`; text-only drafts cannot bypass the
Session worktree ownership check.

Structured drafts accept at most 128 segments, 32 total references, and 131072
aggregate text bytes; rendered server-owned prompt text has the same byte bound.
Historical revision proof uses the exact indexed `(conversation_id, revision)`
snapshot key rather than scanning an unbounded Session journal.

Standard ACP commands stay authoritative for `/`; a command is reclassified as a
capability only when its owning adapter supplies trusted typed metadata, never
by name or description. Kubecode application actions live in a separate small
typed host action registry consumed by the global palette and are never sent as
prompts. The registry has a closed action-ID set and typed local handlers; its
Project requirements produce disabled rows rather than an Agent request. The
global palette combines those local actions with the explicitly active
Session's current catalog snapshot. Catalog selections carry the Session ID,
item kind, opaque ID, and revision back to that Session workspace, which checks
that it is still active and writable and revalidates the current snapshot before
inserting a capability chip or using the typed command endpoint. A command with
text input is completed into that Session's Composer; an argument-free command
is dispatched by opaque coordinates. Catalog replacement swaps the palette
projection wholesale, so a stale row cannot silently target another Session.
Unknown ACP or private metadata is retained but not executable without a
registered adapter decoder. Plugin contributions enter this same catalog only
through explicit user-facing action descriptors; the plugin runtime itself is a
separate management surface and a separate ADR.

The bundled Claude adapter obtains its user-invocable skill inventory from the
Claude Agent SDK query attached to the exact provider Session. It calls
`reloadSkills()` after an ACP command update has returned, so discovery uses the
Session's own cwd (including its worktree) without blocking the SDK message loop
or scanning Claude's global directories. The adapter then publishes a bounded
full replacement in `available_commands_update._meta.kubecode.claudeSkills`.
Only canonical identity, safe display fields, scope/source label, input hint,
and availability cross that private boundary; provider paths are never copied.
When the SDK does not expose a more specific source, the adapter uses Session
scope rather than guessing Project or User ownership. Plugin-qualified canonical
names retain Plugin scope. Missing `reloadSkills()` support or a failed refresh
publishes an unsupported empty skill replacement and leaves standard ACP
commands unchanged.

The server decodes this metadata only for Claude Code Sessions and requires the
advertised canonical identity to match exactly one current ACP command before it
can be enabled. A matched row replaces that command in the safe projection with
a `Skill` item; duplicate identities, missing commands, unsupported inputs, and
provider-disabled rows remain disabled. The raw metadata stays in the private
Session journal, so the same opaque ID and invocation mapping are reconstructed
after reconnect or process restart. Submission resolves the `cap:` ID against
that raw authoritative snapshot in the same transaction that starts the run,
then emits Claude's canonical slash invocation server-side; the browser never
synthesizes or receives the provider invocation template.

The bundled Codex adapter obtains its skill inventory from App Server
`skills/list` for the exact Session cwd and additional roots. Its private
`available_commands_update._meta.kubecode.codexSkills` replacement declares
structured input support and explicitly disables text fallback. Each skill path
is retained only in the private authoritative snapshot as the provider identity;
the safe catalog projects an opaque `cap:` ID, name, description, scope, source
label, and availability. Provider scopes preserve Project, User, System, Admin,
Bundled, and Plugin labels without sending absolute paths to the browser.

Codex skill submission resolves the opaque ID against that raw snapshot in the
same transaction that creates the run. The durable run and user-message event
contain only `$name` plus optional arguments. The exact App Server
`{type: "skill", name, path}` payload is carried in memory through ACP prompt
`_meta`; the adapter inserts it once before ordinary prompt content, so neither
the display token nor the path is double-injected as user text. Reconnect and
process reopen reconstruct the same mapping from the private Session journal,
while unsupported discovery publishes an empty replacement and
`skills/changed` refreshes the current Session catalog.

OpenCode has no separate trusted capability contribution today. Its native ACP
implementation combines commands and skills into standard
`available_commands_update` rows, then omits the internal skill discriminator,
source path, scope, and private invocation snapshot from the protocol update.
The Composer catalog treats those rows only as `Command` items even when a name
or description resembles a skill; unknown OpenCode metadata and provider
version strings never opt a row into capability execution. Slash dispatch stays
provider-native and uses OpenCode's Session snapshot for the exact runtime-owned
cwd, while ordinary prompt dispatch is unchanged.

The absence is an explicit supported state rather than a synthesized empty
skill registry. Initial creation, load, and resume may replace the OpenCode
command snapshot; journal reopen preserves it exactly, and a later empty update
removes prior rows with a new revision. Once the safe catalog is hydrated, the
Composer `+` surface exposes a localized capability-empty status while leaving
native commands visible. OpenCode can gain `$` rows only when a future native
contract advertises a stable typed identity and reliable manual invocation and
the server has a registered decoder for that exact contract.

## Composer reference and structured draft

A Composer reference is a typed context or capability chip backed by an opaque
catalog ID, not a raw `@path` string. The draft is an ordered list of typed
segments: `Text`, `ContextRef`, and `CapabilityRef`. A reference segment carries
its opaque ID and the catalog revision it was selected against, and persists per
Session. Copying the Composer yields a readable plain-text fallback such as
`@src/main.rs` or `$skill`; pasting that fallback is ordinary text until the user
re-selects a catalog result, so a pasted name is never trusted as an ID.
Capability selection inserts a `CapabilityRef` immediately from the hydrated
snapshot; it never writes provider wire text. Keyboard, pointer, and touch
selection share one enabled-row cursor, and IME composition events cannot
select, dismiss, or submit a result. Loading, failure, empty, stale, and
unsupported states remain explicit; any non-available chip blocks submission
until it is removed or selected again from a current catalog revision.
File and directory context search uses a Session-scoped adapter over
`WorkspaceService`: the server derives the exact Project/worktree execution root
from the Session, accepts only relative directory queries, and mints an opaque
context ID only after resolving the selected relative path again. The general
Project-root picker remains shared by quick open and file creation but is not
the Composer authority. A draft with no references is exactly today's
plain-text prompt.

## Project path picker

The Project path picker is a browser presentation abstraction shared by quick
file open and relative new-file/new-folder creation. It uses Project IDs plus
validated relative entries from the existing Workspace API; it never resolves
or exposes an unregistered absolute server path. The Composer may reuse its
list/search presentation, but supplies a Session-scoped data adapter and context
registration action rather than this Project-root API.
Recursive search is bounded, defaults to excluding entries annotated as hidden,
ignored, or generated by `WorkspaceService`, and discards responses superseded
by a newer query. Generated classification covers the common build/cache
directory names defined by the Runtime; clients consume the flag instead of
guessing from paths.

Composer context search resolves entries through a Session-scoped endpoint
(`GET /sessions/{conversation_id}/entries`) that derives the execution root
entirely from the conversation record: a shared Session uses its registered
Project root and a worktree Session uses the exact worktree owned by its
`agent_session_id`. Related Agent Chats may share that execution boundary while
retaining distinct conversation IDs. The browser supplies only a validated
relative directory path and receives at most 512 safe relative `Entry` rows per
directory; no arbitrary or absolute path is accepted or exposed. Project
registration is a common prerequisite for both modes, so a retained worktree
can never be listed after its Project is unregistered. Execution-mode and
`workspace_path` consistency is enforced, so a corrupted record or a path
pointed at another Agent Session's worktree is rejected with a path-free public
error rather than falling back or exposing private server state.

Project registration uses the same keyboard and visual interaction but a
server-directory adapter. Its value remains an absolute server path and calls
only the existing create/import and directory-listing APIs. Create requires a
non-existing target; Import requires an existing directory. Switching modes
does not discard the typed path.

## Session and run

A Session is a durable relationship between one Agent Session and one Agent. It owns
the provider Session ID, manual and Agent titles, retained ACP state, archive
state, activity timestamps, and an ordered Session event history. A Session may
reference a parent as a provider-native fork or subagent; imported subagent
transcripts may be marked read-only. The user-facing `Delete` operation removes
only Kubecode state after disconnecting its active actor.
Provider-native history remains owned by the Agent and can be imported again.

A run is one user prompt and its normalized Agent events. A Session has at most
one active run, while different Sessions can run concurrently. Runs may be
running, waiting for input, completed, failed, cancelled, timed out, or
interrupted.

A Native Session Mode is an opaque provider-owned ID, name, description, and
option set retained in ordered Session events. ACP `current_mode` is canonical;
a select configuration with category or ID `mode` is a compatibility fallback.
Kubecode does not persist a cross-provider mode enum or a default preference.
`mode_access` is a computed API projection, not durable Session state. It
expresses whether the user may change mode and why the control is locked:
active run, read-only Session, Team Teammate, Team Discriminator, or a Codex or
Claude Code permission mode owned by Team YOLO. Mode-like Session API mutations
enforce the same projection and apply only between turns. OpenCode Build/Plan
remains separate from its process-scoped Team permission environment.

A Session-state checkpoint is the full ACP NewSession or LoadSession response,
including provider-authored mode and configuration labels. `AgentStore`
persists that raw response only in the Session journal and, in the same
transaction, appends a browser-safe `session_state` workspace invalidation with
an empty object payload. The event derives its Project and Session scope from
the stored Conversation, carries no provider metadata, and is published only
after commit. Checkpoint persistence is part of Session readiness: failure
prevents the actor from reporting ready. The browser responds by rehydrating
the existing Session-state API projection through generation and active-Session
guards, so stale or cross-Session responses cannot replace newer state.
Incremental state updates such as ACP `available_commands_update` use the same
atomic invalidation path whether the actor is idle or running a turn. Multiple
state changes in one store batch produce one conversation-scoped wakeup, and
the browser always rehydrates the complete safe projection rather than
interpreting private journal payloads. Raw provider metadata remains only in
the private Session journal and never enters a run or workspace event.

Session history is read in bounded cursor pages ordered by run insertion. Each
page returns its run events and the corresponding Session events, while the
browser preserves stable identities when older history is prepended or live
events arrive. Pagination changes transfer and rendering cost, not ownership or
retention: SQLite remains the complete durable history.

## Open editor document

An open editor document is browser presentation state identified by Project ID
and validated relative path. It contains the latest server document plus an
independent draft. A dirty close requires user confirmation. Optional Auto Save
uses the same Project-scoped write API after an idle delay; it does not add
another filesystem boundary or allow absolute paths.

## ACP actor

`AgentRuntime` owns at most one actor per connected Session. The actor
serializes prompts, polls mode and configuration changes while a prompt is
active, and normalizes ACP updates into durable Kubecode events. It resumes an
existing provider Session when possible and falls back to loading it. Inactive
actors expire after two minutes and only four inactive actors remain warm;
active prompts are exempt from eviction. Team draft initialization may persist
provider identity without retaining a warm actor.

The connection-scoped Session update journal coalesces adjacent text and
thinking fragments with the same provider identity. Its fixed window starts at
the first fragment and is never extended by later fragments. It flushes on a
short interval and before semantic or lifecycle events. One transaction commits
the complete window across Session, run, and workspace projections. Shutdown
rejects new producers, drains accepted updates, and joins the journal worker,
so batching changes neither text reconstruction nor durable ordering.
Each actor journal also carries the actor generation. Generation replacement
is mutually exclusive with a journal commit: an old actor may commit before its
replacement, but it cannot publish Session state after the new actor becomes
current. Session creation and load checkpoints use the same guard.

The actor also brokers capability-gated provider extensions without changing
the shared Agent abstraction. Claude side questions are accepted only while a
turn is active and the bundled adapter advertises support, then persist as
ordered Session and workspace events. ACP text normalization retains native
message IDs so the browser can preserve provider message boundaries.

Agent discovery and ACP adapter discovery are separate. CLI authentication,
models, and provider settings remain external to Kubecode.

An ACP stdio launcher uses Tokio-owned child processes and asynchronous pipes
and sets the process cwd to the Agent Session execution path before executing
the adapter. Executable, cwd, and arguments are positional values rather than
interpolated shell text. Actor cancellation owns child termination. ACP request
cwd is retained as protocol context but is not relied upon as the process
directory. OpenCode
also receives the execution path through its native `acp --cwd` option so
directory-service initialization and later ACP requests share the same
boundary.

## Terminal

`TerminalManager` owns each PTY independently of any WebSocket. A terminal is
bound at creation to either the selected Agent Session execution path or the
Project root and has a `regular`, `claude_code`, `codex`, or `opencode` profile.
The API accepts an optional Session ID, verifies Project ownership, and resolves
the stored path through `WorkspaceService`; it never accepts a browser-provided
cwd. A bounded byte buffer with monotonic cursors lets browsers reconnect
without restarting the process.

Regular profiles launch the user's shell directly. Agent TUI profiles use the
Runtime-discovered executable as a positional argument to an interactive login
shell and then `exec` it. This loads the same user shell configuration as a
terminal-launched CLI while avoiding shell interpolation of the executable
path. The Runtime, not an individual client, owns this behavior.

Executable discovery is separate from Agent TUI execution. Managed native
clients can set `KUBECODE_DISABLE_LOGIN_SHELL_DISCOVERY=1` so catalog refreshes
never launch a user login shell merely to search PATH. Explicit overrides,
inherited PATH, and known installation locations still participate. The flag
does not suppress the interactive login shell used by an explicitly opened
Agent TUI.

The frontend's terminal group and recursive split tree are presentation state;
each leaf still refers to an independent server PTY. Selecting another Session
does not move existing PTYs. Splits and restarts inherit their source PTY's
Session context.

## Workspace event

A workspace event is a durable, globally ordered metadata notification. One SSE
connection carries Project, Session, run, file, Git, and terminal changes. The
client retains a bounded ordered window rather than only the newest event.

`WorkspaceEventBus` is the process-local wakeup boundary for that durable log.
The shared `AgentStore` initializes its latest-value watch cursor from the
non-empty SQLite log and advances it monotonically only after the transaction
that inserted a workspace event commits. A rollback never advances the bus.
The watched cursor is not a payload or delivery acknowledgment: consumers
subscribe before their final catch-up read and query ordered SQLite pages after
their own durable cursor. Several writes may therefore coalesce into one wakeup
without losing an event, and a late subscriber starts at the latest committed
cursor. An SSE consumer holds at most one 512-event durable page, drains it in
order according to client demand, and then waits on its private watch receiver.
This bounds per-client buffering and isolates slow clients from writers and
other consumers. A 30-second safety read repairs a missed wake publication. The
bus has no worker or buffered event queue; SSE waits retain only a weak store
reference, so dropping the owning store closes the channel and releases
subscribers during Runtime shutdown.

## Explorer workbench

The default Explorer has three independently collapsible sections:

- Changes: Git status and file diffs with stage, unstage, discard, init, and commit.
- Agent Plan: the active Session's complete dynamic checklist.
- Files: a lazy Project tree and CodeMirror editor.

Opening a file changes context without replacing the Agent Session. File writes
use a revision token and return HTTP 409 on stale content.

## Workspace attention

Global Session summaries project durable state needed by navigation: Project,
Agent, title, latest run status, activity, archive state, parent relation, and
optional durable Team identity (`team_id`, `team_role`, `team_title`, and
`team_status`). The browser combines these summaries with new workspace events
to render cross-Project input-required navigation. Rich Team snapshots remain a
separate task/member view and are independently recoverable after a partial load
or SSE reconnect.

Notification preferences are versioned browser-local state. Workspace events
map to completion, attention, or error categories. The browser's native
notification permission and focus state determine delivery; no custom audio
pipeline exists.

## Application message

An application message is transient in-workbench feedback with a severity,
message, and optional source. A single host renders at most three deduplicated
messages within the viewport. Compact messages truncate visually and retain the
complete diagnostic in an expandable view. Permission and elicitation requests
are not application messages: they remain durable Session attention state.

Application messages never request or deliver browser/system notifications.
Those remain the responsibility of workspace notification preferences and the
notification bridge.

## Appearance

Appearance is browser-local. A versioned preference record stores color scheme,
theme, UI font, UI font size, code font, and terminal font. UI font size is an
integer from 12 through 20 pixels and defaults to 14 when an older preference
record has no value. It scales workbench chrome, Agent messages, and the
Composer without changing CodeMirror or xterm metrics. Semantic CSS tokens feed
the workspace, CodeMirror, and xterm so theme changes do not reconnect a PTY.
