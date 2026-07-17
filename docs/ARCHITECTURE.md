# Architecture

Kubecode is a browser application backed by a standalone Rust server. The
active production boundary is defined by ADRs 0161–0179.

## Runtime topology

The React client is served below `NB_PREFIX`, which allows the same image to run
at a Kubeflow Notebook subpath. `KubecodeApi` derives HTTP, SSE, and WebSocket
routes from the current browser pathname. Health probes remain unprefixed at
`/healthz` and `/readyz`.

The Axum server composes seven services:

- `WorkspaceService` registers Project roots and contains filesystem access.
- `AgentStore` persists Sessions, runs, normalized events, and workspace events.
- `AgentRuntime` owns long-lived ACP actors for Claude Code, Codex, and OpenCode.
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

Disabling Workspaces is a protected migration rather than a preference flip.
The server blocks on active runs, requires Merge, Export patch, or Discard for
every worktree, disconnects the ACP actor, then changes the Session cwd to the
Project root. The Project setting changes only after every worktree succeeds;
partial failures remain resumable while Workspaces stays enabled.

## Browser workspace

`src/kubecode/App.tsx` renders a Project rail, grouped Session navigator,
primary Agent timeline/composer, a docked Details pane, and a Terminal dock.
All three surrounding panels are resizable and independently collapsible. The
Details overview presents collapsible Changes and Files trees together; opening
a file or diff switches that dock to CodeMirror or diff content without
replacing the active Agent Session.

The Session navigator searches, filters, sorts, groups, archives, forks, and
deletes Sessions. Needs-input and running Sessions are promoted above date
groups. Provider-native fork or subagent relationships remain visible, and
read-only subagent transcripts do not expose a composer.

The terminal dock manages independent shell or Agent TUI PTYs. Its recursive
split tree and split ratios live in browser state; PTY processes, output cursors,
and lifecycle state live on the server. Browser refresh can restore serialized
xterm output and replay newer bytes from the server cursor.

## Agent sessions

The server discovers exactly three CLIs: Claude Code, Codex, and OpenCode.
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

The Agent Composer keeps ACP-native mode, model, effort, and configuration
controls behind one summary button in its compact lower action row. Its
searchable add palette lists the current session's dynamic
`available_commands` and reuses the project file tree to insert a relative
`@path` reference; Kubecode does not invent a separate cross-Agent skill
registry or copy file contents into the prompt. Long prompts stop growing at a
bounded editor height and scroll inside the Composer instead of resizing the
Agent workspace. While an Agent turn is running, the editor remains writable
and stores an isolated draft per Session; submission resumes after the current
turn completes or is stopped.

Team Sessions start with one fixed Leader and dynamically add teammate Agent
Chats through the `kubecode-team` MCP server. Agents that advertise HTTP receive
an authenticated streamable HTTP endpoint on new, load, and resume; the
in-process ACP bridge remains a new-session fallback for other agents.
Leader-only operations are transactionally enforced; teammates can claim
unblocked tasks, message one another, and submit results into the Leader
mailbox. An idle Leader is automatically continued when a result arrives.
Provider-native subagents remain nested under their owning member and are not
promoted into Team membership.

The Team runtime persists member-management policy, a parallel-run limit,
lineup proposals, structured activity, and delivery state for every mailbox
message. Delegation assigns the task and enqueues its message in one SQLite
transaction. Pending messages wake the recipient's existing ACP Session with an
internal run; delivery is acknowledged when the member reads Team context and
failed delivery stops retrying after three attempts. Runtime reconciliation on
Team reads and workspace reconnects resumes queued work without creating a new
member Session.

Each member's internal runs are stored only in that member's durable Chat.
Kubecode hides the synthetic wake prompt but keeps the Agent's reasoning, tool
calls, permissions, and response visible. The browser separates this member
Chat navigation from a Team control view containing runtime summary, attention,
lineup approval, roster, task board, dependency, and activity projections.
Workspace `team_*` events refresh the projection without merging member
transcripts into the Leader Chat. The Team task board is the flexible main
surface and shows only task title and assignee; a collapsible compact member
rail on the right shows Agent, name, role, and runtime status.

Teammate ACP permission requests are persisted as Team permission records and
sent to the Leader mailbox before any human controls are shown. The Leader uses
`team_review_permission` with an exact Agent-provided option or explicitly
escalates the request to the user. Permission waits have no timer-based
escalation. A waiting Teammate does not consume the Leader's coordination slot,
preventing a scheduling deadlock. Leader permissions remain user-owned.

Teammate creation may apply an Agent-native ACP mode and dynamic configuration
map after the member Session is initialized. Any rejected option rolls back the
member and its local conversation. The Leader can stop/remove a teammate through
Team MCP; removal disconnects the ACP actor, releases active task assignments,
deletes its provider-native and Kubecode Session records, and does not delete
Project files.

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
Deleting the fixed Leader is a confirmed Team disband operation that disconnects
and deletes every member Session before removing Team coordination state. Provider-backed Sessions are
deleted through ACP `session/delete`. OpenCode falls back to its native
`session delete` command when its ACP adapter advertises only close; close itself
is never presented as deletion. A conversation without a provider Session is
deleted locally. Provider failure is surfaced instead of silently degrading to
local-only removal.

ACP capabilities drive the UI. Commands, fork, modes, configuration, plans,
permissions, elicitation, and usage appear only when advertised by the active
Agent. Kubecode does not implement a second permission-mode abstraction.

Session deletion removes the provider-native history and Kubecode's record.
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

## Deployment

`deploy/Dockerfile` builds the React client and Rust server, installs the three
supported CLIs and ACP adapters, and uses s6 for persistent CLI configuration.
`deploy/kubeflow-notebook.yaml` demonstrates a PVC-backed Notebook deployment.
