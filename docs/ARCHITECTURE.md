# Architecture

Kubecode is a browser application backed by a standalone Rust server. The
active production boundary is defined by ADRs 0161–0203.

## Runtime topology

The React client is served at `/` or below a generic configured base path.
`KubecodeApi` derives HTTP, SSE, and WebSocket routes from the current browser
pathname. Health probes remain unprefixed at `/healthz` and `/readyz`.

The same executable can run as an API-only Runtime for native clients. In that
mode it serves discovery plus the versioned API without React assets, requires
one bearer token across client-owned REST, SSE, and WebSocket routes, and
reports its ephemeral loopback port through a machine-readable readiness
document. Provider-owned Team MCP requests use a separate unguessable token in
their internal endpoint because ACP providers do not receive the native
client's bearer. That route bypasses only the outer client bearer middleware;
the Team MCP handler still validates its process-local token and conversation
membership. Browser mode and its external reverse-proxy security model are
unchanged.

The client API includes `GET /api/v1/runtime/status`. Its typed five-field
snapshot combines `AgentRuntime` actor counts and warm-pool policy with the
latest committed SQLite workspace-event cursor and delivery availability. It
is nested below the configured generic base path and, in API-only mode, inside
the existing bearer middleware. The snapshot is operational metadata only: it
contains no Session detail, user content, credentials, filenames, executable
locations, Project paths, or arbitrary server paths.

The Axum server composes eight services:

- `WorkspaceService` registers Project roots and contains filesystem access.
- `AgentStore` persists Sessions, runs, normalized events, and workspace events.
  It also owns the process-wide `WorkspaceEventBus`, whose latest-value cursor
  wakes live consumers after durable workspace-event commits.
- `AgentRuntime` owns bounded ACP actors for the currently supported Agents:
  Claude Code, Codex, and OpenCode. Tokio owns adapter processes and stdio;
  inactive actors expire after two minutes and the warm inactive pool is capped
  at four, while active prompts are never evicted.
- `AgentCatalog` owns the process-wide, dynamically refreshable CLI and ACP
  adapter readiness snapshot shared by Agent Sessions, Teams, and TUI terminals.
- `TerminalManager` owns reconnectable PTYs independently of browser sockets.
- `GitService` performs Project- and Session-scoped Git operations without shell
  interpolation, including bounded Composer diff discovery and resolution.
- `TeamStore` persists Team authority, membership, tasks, and mailboxes.
- `TeamCoordinator` creates teammate Agent Sessions and applies Team scheduling rules.

SQLite is application metadata, not project content. One server-owned
connection is shared by the Workspace, Agent, and Team stores and uses rollback
journaling with immediate write transactions. A process owner lock rejects a
second Kubecode server for the same state database. Project files remain on
disk at their original absolute paths.

A Project may opt into Workspaces. New Agent Sessions can then execute either
at the shared Project root or in a server-managed Git worktree below the private
state directory. The chosen cwd is durable and is used by every ACP lifecycle
operation, not only the first prompt. Existing and imported Sessions remain
shared unless the user explicitly creates an isolated Session.

Every ACP stdio adapter process also starts with that execution path as its
operating-system cwd. New, load, resume, list, fork, hydrate, reconnect, and
delete therefore use the same directory at both the process and protocol layers.
Provider Session identity remains durable when an actor expires. Team drafts
initialize that identity ephemerally and release their actor until Team start.

Disabling Workspaces is a protected migration rather than a preference flip.
The server blocks on active runs, requires Merge, Export patch, or Discard for
every worktree, disconnects the ACP actor, then changes the Session cwd to the
Project root. The Project setting changes only after every worktree succeeds;
partial failures remain resumable while Workspaces stays enabled.

## Browser workspace

`src/kubecode/App.tsx` renders one hierarchical Project/Session navigator, a
primary Agent timeline/composer, a docked Explorer, and a Terminal dock. The
single 44-pixel title bar contains the active Session identity, global Session
search, attention, and layout controls. Navigator visibility is global; Explorer
and Terminal geometry remain Project-scoped. All surrounding panels are
resizable and independently collapsible. Below 980 pixels, the navigator and
Explorer are mutually exclusive overlay panels with a dismissible backdrop;
desktop geometry and resizing remain unchanged.

The navigator searches, filters, sorts, groups, archives, forks, and deletes
Sessions beneath their owning Project. Query matches temporarily reveal
collapsed Projects. Needs-input and running status appears as compact row and
Project indicators. Provider-native fork or subagent relationships remain
visible, and read-only subagent transcripts do not expose a composer.

The Explorer presents independently collapsible Changes, Agent Plan, and Files
sections. Opening files creates Project-relative CodeMirror tabs without
replacing the active Agent Session; each open document retains independent
saved content and draft state. Dirty tabs require confirmation before close,
and optional browser-local Auto Save writes after one second without input.
The lazy Project tree persists expansion per Project and hides hidden,
Git-ignored, and common generated directories unless the user reveals them.
`WorkspaceService` is the single owner of these classifications: every
Project-relative directory entry carries `hidden`, `ignored`, and `generated`
flags so browser and native clients do not maintain divergent path rules.
Filesystem enumeration is isolated from the asynchronous request executor;
slow mounts and host permission mediation may delay the Files projection but
must not block health checks, Sessions, Teams, or terminals.
For local native clients, the Project authorization route verifies a
user-selected canonical path against one registered Project and returns no
filesystem path. This allows platform-native access grants without widening
the Project-ID API boundary.
Project-relative rich-text images use the authenticated binary asset route.
The route resolves paths only through `WorkspaceService`, rejects traversal and
escaping symlinks, returns at most 8 MiB, and exposes no absolute server path.
File search is a separate flat quick-open surface available from Explorer and
Command/Ctrl-P. It traverses only the current registered Project, is bounded to
2,000 visited entries and 100 displayed results, and ignores stale asynchronous
responses. New file/folder paths and Composer file references reuse the same
keyboard-navigable path picker rather than embedding another tree. Opening a
diff remains contextual. The Agent timeline and Composer use one bounded
content width; their scroll containers retain wheel, touch, keyboard, and
auto-follow behavior without drawing scrollbar chrome. The Composer shows only
a Plan progress summary and opens the full checklist in Explorer.

The terminal dock manages independent shell or Agent TUI PTYs. Its recursive
split tree and split ratios live in browser state; PTY processes, output cursors,
and lifecycle state live on the server. A new PTY uses the selected Session's
server-validated execution path, while existing, split, and restarted PTYs keep
their original Session context. Regular terminals execute the user's shell
directly. Agent TUI profiles execute the discovered CLI through that shell in
interactive login mode so the same user-owned environment configuration is
available without putting provider-specific launch behavior in a client.
Browser refresh can restore serialized xterm output and replay newer bytes from
the server cursor.

## Agent sessions

The server currently discovers Claude Code, Codex, and OpenCode.
Claude and Codex use pinned ACP adapters; OpenCode exposes ACP natively. The
standalone payload currently pins Claude ACP 0.61.0 with Claude Agent SDK
0.3.217 so provider-native tools and client-provided Team MCP servers share the
upstream session lifecycle. Each
Session actor stays connected across prompts and persists the provider Session
ID for resume or load after restart.

Discovery records CLI and adapter health separately and can be refreshed
without restarting the server. Existing actors keep their connection; new and
reconnecting actors read the new catalog. Passive readiness never creates a
provider Session or claims authentication. A managed native client may set
`KUBECODE_DISABLE_LOGIN_SHELL_DISCOVERY=1` to skip executable lookup through
user login shells; explicit overrides, inherited PATH, and known install
locations remain available. This does not change the interactive login shell
used after an Agent TUI executable has already been selected.
Real Session startup reports a structured process, initialize, new, load, or
resume stage when it fails.

The current compatibility model maps one conversation to one Agent Session and
records an Agent Session ID, execution mode, and optional worktree path. This
keeps cwd ownership explicit while allowing multiple Agent Chats per execution
Session to be introduced additively.

Edit, Regenerate, and interrupted-turn Undo create immutable revisions inside
the same logical Agent Chat. Before truncating the active timeline, the server
copies its runs, events, and provider identity into a hidden read-only snapshot.
The visible Session ID, Team membership, cwd, and worktree remain stable. The
replacement provider Session receives an explicit recreated transcript context,
while a compact version navigator keeps earlier responses inspectable. Explicit
Fork remains the operation that creates another visible Session. Message edits
never restore Project files implicitly.

Each Git-backed run captures before/after trees through a temporary alternate
index. Restoring a Shared Session requires its current tree to match the stored
after-turn fingerprint; isolated worktree Sessions restore inside their own
boundary. Failed ACP runs also capture their final tree so interrupted-turn
Undo remains available. The real Git index and branch are never changed by
capture.

Session history is exposed as bounded cursor pages. The initial request loads
the newest 50 runs with their normalized run and Session events in chronological
display order; older pages prepend without replacing live events. Once more
than 100 runs are loaded, the browser virtualizes the variable-height timeline
while preserving the visible scroll anchor.

The Agent Composer presents the exact provider-native Session mode and dynamic
configuration in one compact control. Its trigger contains the Agent icon and
current mode; mode, model, effort, fast mode, boolean settings, and other
advertised configuration share the menu. ACP `current_mode` is preferred; a
select configuration categorized or identified as `mode` is the fallback, and
only an exactly equivalent duplicate is removed. Kubecode does not map these
values to a universal Plan/Build enum or save a default for new Sessions.

The Session state API projects whether the user can change mode and a stable
lock reason. Mode changes are rejected during an active turn and in read-only
or Team-owned contexts, so they always apply to a subsequent turn. Standard
Team Leaders own idle mode changes; Teammates and Discriminators do not. Team
YOLO owns Codex and Claude Code permission modes, while OpenCode Build/Plan
remains a Leader-editable profile because its maximum permission policy is
process-scoped.

Full ACP NewSession and LoadSession responses are durable Session-state
checkpoints. The server atomically appends the raw response to the private
Session journal and a conversation-scoped `session_state` workspace
invalidation whose browser payload is exactly `{}`; only after that transaction
commits does it publish the workspace cursor. Browsers then refetch the Session
state projection through the same request-generation and active-Session guards
used by other state invalidations. This lets provider-authored labels replace
an earlier partial mode ID without exposing `_meta` or allowing an older fetch
or a previous Session to overwrite current state.
Incremental ACP state updates use the same atomic, empty-payload invalidation
path while idle or running, so command and mode changes wake connected browsers
without placing raw provider metadata in run or workspace events.
Actor-generation guards cover both incremental updates and full checkpoints;
an evicted or replaced actor cannot overwrite state from its successor.

The Composer resolves context references, Agent and Session commands, and
user-invocable capabilities through one server-owned typed Composer catalog
(ADR 0206), not by routing everything through `/`. `@` attaches bounded
Project-relative context, `/` dispatches the Session's authoritative ACP
`available_commands`, and `$` invokes provider-advertised capabilities; each
selected item becomes a typed chip that carries an opaque server-issued ID. The
catalog is a full snapshot with a monotonic revision scoped to the Session
execution context; the browser submits opaque IDs, a revision, and ordered
draft segments, and the server revalidates revision and each reference before
resolving a private provider invocation. Standard ACP commands stay
authoritative, private adapter extensions are opt-in, and plain-text prompts
remain backward compatible. Long prompts stop growing at a bounded editor
height and scroll inside the Composer instead of resizing the Agent workspace.
The inline `$` picker and Composer `+` capability section consume the same safe
snapshot and ranking function. Trigger recognition is limited to input start or
whitespace boundaries and accepts `$`, `＄`, `¥`, and `￥`; variants normalize
only when the user selects a row. Exact, prefix, substring, subsequence, and
description matches are followed by stable scope/source ordering. Duplicate
display names remain separate opaque identities with kind, source, and scope
badges, while disabled ambiguity reasons and loading/error/empty states are
localized. Selection inserts a typed capability chip, copy emits only the
readable `$name` fallback, and paste remains plain text until an explicit
catalog selection. IME input never triggers keyboard selection or submission.
The browser-wide command palette opens with `Command-Shift-P` on macOS and
`Control-Shift-P` elsewhere. A capture-phase shortcut keeps shifted `P` separate
from the Context Workbench's unshifted file quick-open, while `Command/Control-K`
continues to focus Session search. Palette rows are grouped as local Host
actions, current-Session Agent commands, skills/capabilities, and plugin actions.
Host actions execute only typed browser handlers. Agent rows are disabled when
the active Session is missing, read-only, busy, unavailable, or incompatible;
selection never searches for another writable Session. The active Session and
catalog revision are checked again at selection time. Argument-free commands use
the opaque typed command endpoint, text-input commands focus a completed `/`
draft, and capabilities insert the same typed chip used by `$` and Composer `+`.
Closing the palette without selecting restores its prior focus target.
During the phased migration, the existing `available_commands` Session-state
field exposes only safe standard command display fields and recognized text
input shapes with optional provider-authored hints. Session state also hydrates
the durable safe catalog snapshot.
ACP updates atomically commit their private raw authority, the revised safe
catalog, and a conversation-scoped full-snapshot workspace event. `POST
/projects/:project_id/sessions/:conversation_id/commands` accepts either the
transitional exact-name selector or an opaque item ID with its catalog revision;
the typed path validates and creates its internal run in one store transaction,
then dispatches only the server-resolved prompt. Unknown slash text remains an
ordinary prompt. File, directory, and Git diff chips are registered and
batch-validated through Session-scoped Composer context endpoints. Git diff
discovery uses `GET /sessions/{conversation_id}/composer/git-diffs`; registration
submits a selector and patch revision, never patch content. Structured run requests carry
only ordered text plus opaque context/capability coordinates; filesystem
eligibility is preflighted through `WorkspaceService`, then database-owned
authorization, historical selection proof, current-catalog proof, availability,
and run creation are rechecked in one immediate store transaction. Standard ACP
commands resolve the ordered segment text as their input. Capability references
without a registered server resolver fail closed and never degrade to display
text or the legacy command-name route. Catalog revision issuance uses a durable
Session-row high-water mark that is not rewound with chat history. Rewind
reconciliation compares the retained snapshot with durable Session context
identities inside the same transaction and, when they differ, emits one new full
snapshot above that high-water mark. Structured request bounds are checked before
`WorkspaceService` resolves the exact Shared or Session-owned worktree execution
root, including for drafts with no context references. Git references are
regenerated at that root immediately before the transaction and must retain the
exact patch digest selected by the browser. Only then is the bounded patch added
to the private provider prompt; catalog snapshots and workspace events expose
numeric summaries but no patch content. Complete diffs are capped at 32 files,
128 hunks, and 64 KiB, while selected files are capped at 64 hunks and 32 KiB;
binary, generated, unsupported, and over-limit choices fail closed with stable
Composer errors rather than truncation. Safe snapshots are bounded across standard
ACP and trusted-adapter sources; invalid identities are omitted, and unsupported
trusted command shapes stay disabled rather than falling through to ACP name
resolution.

Claude skill discovery is owned by the bundled adapter. Each standard Claude
`available_commands_update` is forwarded immediately, then the adapter refreshes
the exact Session query through the Claude Agent SDK's `reloadSkills()` control
request and publishes a bounded full skill inventory in private ACP `_meta`.
Refreshes are serialized per provider Session and coalesce to the latest command
snapshot, so reconnect and mid-Session skill changes replace the catalog without
restarting the actor. The adapter allowlists safe fields and never forwards a
skill path. The server's registered Claude decoder reclassifies only identities
that also match a current ACP command, persists the raw trusted snapshot with the
safe catalog revision, and reconstructs the private canonical slash invocation
after restart. Unsupported SDKs publish no skills; duplicate, disabled,
unmatched, and unsupported-input rows fail closed.

Codex skill discovery stays inside the bundled Codex ACP adapter and uses the
App Server `skills/list` result for the exact Session cwd and additional roots.
The pinned adapter dependency is compatibility-patched to publish a bounded
private `codexSkills` replacement, refresh it after `skills/changed`, and omit
configured skills from standard ACP commands because text `$skill` fallback is
not advertised. The private inventory retains the provider path as its stable
identity while the browser receives only opaque IDs, safe display fields, and
scope labels. On selection, the server revalidates the raw inventory in the run
transaction, stores only a safe `$name` display message, and places the exact
`{type: "skill", name, path}` input in ACP prompt `_meta` for that in-memory
dispatch. The patched adapter prepends that structured App Server input exactly
once and redacts paths when replaying provider history. Missing support,
malformed paths, duplicate identities, and disabled rows fail closed.

OpenCode continues to run its native `opencode acp` process without a Kubecode
adapter. Its supported native ACP implementation (verified with 1.17.20) merges
OpenCode commands and skills into `available_commands_update`, but deliberately
projects only the standard `name` and `description` fields; the internal
`source: "skill"`, source location, scope, and invocation snapshot do not cross
the ACP boundary. Kubecode therefore retains every advertised row as a `/`
`Command` and never infers a `$` capability from its name, description, provider
version, config paths, or unknown metadata. OpenCode still resolves slash
invocations natively against the exact Session cwd, so standard commands and
ordinary prompts remain available.

New, load, and resume each replace the OpenCode command snapshot for the
server-owned Session execution path. Reconnect reconstructs the same safe
catalog from the durable journal; an empty replacement removes old rows and
advances the catalog revision. A future OpenCode release may contribute `$`
items only after it advertises a stable typed identity plus a manual invocation
contract and Kubecode registers an explicit decoder. Until then the hydrated
Composer `+` menu shows a localized capability-empty status without hiding
native commands or blocking prompt submission.

While an Agent turn is running, the editor remains writable and stores an
isolated draft per Session; submission resumes after the current turn completes
or is stopped.

The bundled Claude ACP adapter advertises a private side-question capability.
During an active supported Claude turn, `/btw` dispatches the Claude Agent SDK's
native side-question request through `_claude/side_question`; its durable result
appears in a collapsible panel above the Composer without interrupting the main
turn. Unsupported adapters, Codex, and OpenCode do not expose the command. ACP
text chunks retain `messageId` so separate provider messages remain separate
response blocks during long-running output.

Team Sessions are created as Drafts with one fixed Leader. Before execution the
Team Board requires a goal, acceptance criteria, allowed installed Agents,
teammate/concurrency limits, and Standard or YOLO mode. The Leader then
dynamically adds teammate Agent Chats through the `kubecode-team` MCP server
without a second lineup-approval step. Agents that advertise HTTP receive
an authenticated streamable HTTP endpoint on new, load, and resume; the
in-process ACP bridge remains a new-session fallback for other agents.
Leader-only operations are transactionally enforced. The Leader cannot be a
task assignee, but may inspect and edit the workspace to integrate accepted
results and owns the final synthesis. Teammates claim unblocked tasks, message
one another, and submit plans or results into the Leader mailbox. An idle
Leader is automatically continued when a result or failure arrives.
Provider-native subagents remain nested under their owning member and are not
promoted into Team membership.

The Team runtime persists its lifecycle, including an explicit Paused state,
goal, acceptance criteria, Agent
allowlist, parallel/member/review limits, structured activity, and delivery
state for every mailbox message. Delegation assigns the task, creates a durable
Task Attempt, and enqueues its message in one SQLite transaction. The Attempt
binds to the internal ACP run and records queued, running, missing-report,
submitted, completed, or failed state with structured rate-limit, quota, auth,
permission, protocol, process, timeout, and interruption failures. One missing
result reminder is automatic; a second unreported completion fails the Attempt
and wakes the Leader. Runtime reconciliation resumes queued work after Team
reads, server restart, or workspace reconnect without creating a new member
Session. Delivered mailbox messages use an acknowledgement lease; reading Team
context acknowledges them, while the supervisor retries an expired lease at
most three times.

A server-owned supervisor runs at startup and every 30 seconds. It reconciles
all non-terminal Teams, recovers interrupted startup, wakes queued members,
detects a Leader that has not established a task graph, and processes lifecycle
recovery without depending on a browser connection or Team API read.

Team mode has separate requested and effective values. A requested YOLO Team
uses exact provider-native permission controls: Codex
`mode=agent-full-access`, Claude Code `mode=bypassPermissions`, and a
process-scoped OpenCode `OPENCODE_PERMISSION='{"*":"allow"}'`. If an exact
native profile is unavailable, the effective mode becomes Standard and the
Agent, stable reason code, diagnostic, and timestamp are persisted. Each member
also persists whether Kubecode applied a native permission profile and its
prior mode, allowing completion or fallback to restore permissions after a
server restart. Model, effort, fast mode, and other Agent settings are not part
of the Team permission policy.

Each member's internal runs are stored only in that member's durable Chat.
Kubecode hides the synthetic wake prompt but keeps the Agent's reasoning, tool
calls, permissions, and response visible. The browser separates this member
Chat navigation from a Team control view containing setup, runtime summary,
attention, task board, dependency, verification, and activity projections.
The Team control view can pause or resume the complete Team and inspect a
selected task without opening its full prompt on every card. From the Inspector,
the user can assign, retry, cancel, open the assignee Session, or remove a
non-Leader member; destructive operations require confirmation.
Workspace `team_*` events refresh the projection without merging member
transcripts into the Leader Chat. The Team task board is the flexible main
surface: full-width status columns use the active application theme, and each
card shows only its task title and assigned member. There is no separate roster
inside this view; member Sessions remain available through Session navigation.

Teammate ACP permission requests are persisted as Team permission records and
sent to the Leader mailbox before any human controls are shown. The Leader uses
`team_review_permission` with an exact Agent-provided option or explicitly
escalates the request to the user in Standard mode. YOLO mode disables
escalation and requires a Leader decision; failure to decide becomes Team
attention rather than an implicit approval. Permission waits have no timer-based
escalation. A waiting Teammate does not consume the Leader's coordination slot,
preventing a scheduling deadlock. Leader permissions remain user-owned.

`team_complete` is the only normal Team completion transition. At least one
required task must be accepted and no permission or failed delivery may remain.
Cancelling a task atomically makes it non-required and closes its active attempt
and unresolved deliveries. Failed or cancelled work can be explicitly retried,
which restores the completion requirement and recalculates dependency blocking.
YOLO Teams additionally create a fresh Discriminator Session after required work
is accepted. Runtime chooses an allowed backend in deterministic rotation,
applies its exact read-only control (Codex `read-only`, Claude Code `plan`, or
OpenCode `plan`), and captures the Git tree fingerprint.
The Discriminator can inspect evidence and submit a pass/reject verdict but
cannot own tasks, edit implementation, or communicate outside that verdict. A
rejection returns findings to the Leader and cannot be overridden. A pass is
invalid when the workspace fingerprint changes; exhausting the configured
review rounds moves the Team to Needs Attention.

Teammate creation may apply an Agent-native ACP mode and dynamic configuration
map after the member Session is initialized. Provisioning is durable. Transport
failure rolls back the temporary member and conversation while retaining the
diagnostic; rejected configuration keeps the member in `configuring`. The
Leader can reconfigure or replace the member, retry or cancel concrete work,
and remains the only semantic scheduler.

Shared Team members execute at the Team root. Explicit isolation creates a
separate Agent Session and worktree while recording the base tree for Leader
review. Accepting an isolated file-changing result performs a private-index
three-way Git tree merge into the Leader workspace; conflicts leave the Leader
tree untouched. Existing Solo Sessions can be promoted without replacing their Chat
history or provider identity. Promotion reconnects an available provider actor
and resumes that identity with the new Team MCP endpoint; a reconnect failure
removes the new coordination record while preserving the Solo Session.

Team identity is read from durable Team and member records on every Project
load. A stale record whose conversation was removed is isolated rather than
failing the complete Team collection, and removing a Leader also removes its
coordination record. Created, promoted, and recreated ACP actors attach the
current process's Team MCP URL to provider load/resume requests. The ordinary Session deletion path rejects
direct teammate deletion before disconnecting its ACP actor. Teammates can only
be deleted by their Leader through Team MCP, so a browser action cannot bypass
Team ownership or leave a stale member. Project and global Session list responses project `team_id` and
`team_role` directly from those durable records, so navigation does not depend
on a separate Team snapshot request. Terminal, Session, and Team snapshots
hydrate independently; the browser refreshes Team snapshots while a Project is
active and immediately after the global SSE connection opens or reconnects.
Team names are persisted in the Team record. Project navigation renders each
Team as a named hierarchy with its fixed Leader first and teammates nested
below it; only Solo Sessions participate in activity/time sections.

The browser does not expose `Delete` for teammates. The Leader discovers current
member IDs with `team_list_members` and removes a teammate with
`team_remove_teammate`; that operation affects only the selected member.
Teammate removal and fixed-Leader disband are local-first operations. Kubecode
immediately removes roster and local Session state, releases assignments, and
never deletes Project files or provider-native Session history. Historical
provider-cleanup records are completed without contacting the provider.

The Leader can call `team_request_user_input` for a semantic decision it cannot
safely make. The durable request moves the Team to Needs Attention and pauses
teammate scheduling. The browser answers inline; the server resumes the prior
Team state and delivers the answer through the Leader mailbox. Completed and
disbanding Teams keep MCP coordination state read-only.

ACP capabilities drive the UI. Commands, fork, modes, configuration, plans,
permissions, elicitation, and usage appear only when advertised by the active
Agent. Kubecode does not implement a second permission-mode abstraction.

Session deletion disconnects the active actor and removes only Kubecode's
record. Provider-native history remains owned by the Agent.
Project deletion unregisters the Project and does not modify its directory.

Browser system notifications are derived from live workspace events for
completion, input-required, and error outcomes. Settings control focus policy,
categories, and whether the operating system may play its normal notification
sound. Permission is requested only from explicit UI.

Application messages use a separate React-level message host. Git, file,
Session, and Terminal operations publish typed `debug`, `info`, `success`,
`warning`, or `error` messages without invoking browser notification APIs.
The host bounds, deduplicates, expands, and dismisses diagnostic text so a
backend error cannot participate in panel sizing.

## Event model

One global SSE stream multiplexes Session, run, file, Git, and terminal metadata
events. Events have monotonically increasing IDs so reconnecting clients can
resume. The browser first reads the durable current cursor, then opens SSE from
that position so historical events cannot create stale system notifications.
SQLite is the only authority for workspace-event payloads and ordering. The
shared `AgentStore` initializes its `WorkspaceEventBus` from the latest durable
cursor. Direct inserts publish after autocommit; transactional writers,
including a batched Agent Runtime flush, publish their newest cursor only after
the complete transaction commits. Failed or rolled-back writes are silent.
The latest-value wakeup may coalesce, so consumers subscribe before a final
durable catch-up read and always replay SQLite from their own cursor. Delayed
concurrent publications cannot lower the visible cursor. Each SSE response
buffers at most one ordered 512-row SQLite page, drains it according to body
demand, and waits on its own watch receiver when caught up, so a stalled browser
cannot block writers or other consumers. A 30-second defensive read recovers a
durable row if its wake publication is missed. The response holds only a weak
store reference while idle; dropping the shared store during Runtime shutdown
closes the bus and releases waiting consumers. The bus owns no payload queue or
shutdown task.
ACP text and thinking fragments are combined by a connection-scoped journal
for a fixed window of up to 33 milliseconds anchored at its first fragment.
Semantic and lifecycle events force an immediate flush, and one SQLite
transaction writes the complete window's Session, run, and workspace rows.
Flush and shutdown are persistence fences; shutdown also joins the worker before
the ACP actor exits. SSE schemas and reconnect cursors therefore remain stable
without exposing provider token boundaries as application events.
PTY bytes use dedicated WebSockets because terminal streams have different
buffering and cursor semantics.

## Distribution

GitHub Actions publishes self-contained Linux amd64 and arm64 archives and
Debian packages. Each archive contains the React build, a musl-linked Rust
server, a pinned Node.js runtime, and production-only Claude/Codex ACP bridge
dependencies. Provider Agent CLIs, credentials, Git, and the user's shell
remain host-owned.

`bin/kubecode` resolves the archive relative to itself, configures static and
adapter paths, and replaces itself with the Rust server. The server defaults to
loopback, uses `$HOME` as the directory-picker root, and stores application
state below the XDG data directory. A generic base path supports downstream
reverse proxies without binding the runtime to a specific platform.

The Debian package wraps that same directory below `/usr/lib/kubecode` and
adds `/usr/bin/kubecode`; it does not install or enable a service. Kubecode
does not publish an official container or cluster manifest. Downstream
deployments remain responsible for filesystem permissions, routing,
authentication, and persistence.
