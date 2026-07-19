# Architecture

Kubecode is a browser application backed by a standalone Rust server. The
active production boundary is defined by ADRs 0161–0194.

## Runtime topology

The React client is served at `/` or below a generic configured base path.
`KubecodeApi` derives HTTP, SSE, and WebSocket routes from the current browser
pathname. Health probes remain unprefixed at `/healthz` and `/readyz`.

The Axum server composes seven services:

- `WorkspaceService` registers Project roots and contains filesystem access.
- `AgentStore` persists Sessions, runs, normalized events, and workspace events.
- `AgentRuntime` owns long-lived ACP actors for the currently supported Agents:
  Claude Code, Codex, and OpenCode.
- `TerminalManager` owns reconnectable PTYs independently of browser sockets.
- `GitService` performs Project-scoped Git operations without shell interpolation.
- `TeamStore` persists Team authority, membership, tasks, and mailboxes.
- `TeamCoordinator` creates teammate Agent Sessions and applies Team scheduling rules.

SQLite is application metadata, not project content. Project files remain on
disk at their original absolute paths.

A Project may opt into Workspaces. New Agent Sessions can then execute either
at the shared Project root or in a server-managed Git worktree below the private
state directory. The chosen cwd is durable and is used by every ACP lifecycle
operation, not only the first prompt. Existing and imported Sessions remain
shared unless the user explicitly creates an isolated Session.

Every ACP stdio adapter process also starts with that execution path as its
operating-system cwd. New, load, resume, list, fork, hydrate, reconnect, and
delete therefore use the same directory at both the process and protocol layers.

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
and lifecycle state live on the server. Browser refresh can restore serialized
xterm output and replay newer bytes from the server cursor.

## Agent sessions

The server currently discovers Claude Code, Codex, and OpenCode.
Claude and Codex use pinned ACP adapters; OpenCode exposes ACP natively. Each
Session actor stays connected across prompts and persists the provider Session
ID for resume or load after restart.

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

The Agent Composer keeps ACP-native mode, model, effort, and configuration
controls behind one summary button in its compact lower action row. Its
searchable add palette lists the current session's dynamic
`available_commands` and uses the flat Project file picker to insert a relative
`@path` reference; Kubecode does not invent a separate cross-Agent skill
registry or copy file contents into the prompt. Long prompts stop growing at a
bounded editor height and scroll inside the Composer instead of resizing the
Agent workspace. While an Agent turn is running, the editor remains writable
and stores an isolated draft per Session; submission resumes after the current
turn completes or is stopped.

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
history or provider identity.

Team identity is read from durable Team and member records on every Project
load. A stale record whose conversation was removed is isolated rather than
failing the complete Team collection, and removing a Leader also removes its
coordination record. Recreated ACP actors attach the current process's Team MCP
URL to provider load/resume requests. The ordinary Session deletion path rejects
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
