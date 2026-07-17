# Abstractions

## Project

A Project is an application ID mapped to an absolute canonical server path.
`WorkspaceService` is the only layer allowed to translate the ID and a
browser-supplied relative path into a filesystem path. It rejects traversal,
escaping symlinks, and the private Kubecode state directory.

Registering or importing a Project adds metadata to SQLite. Unregistering it
removes that metadata only; it never removes the Project directory or files.

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
explicit lifecycle. A Draft becomes Active only after the user supplies its
goal, acceptance criteria, allowed installed Agents, and teammate/concurrency
budget. Every member owns an independent Agent Chat and provider Session.
Shared members use the Team cwd; an explicitly isolated member receives a
worktree and stores its base Git tree. Only the Leader may add members, review
plans/results, integrate accepted work, and author the final Team response.
The Leader may edit the workspace but can never be a concrete task assignee.

A Team mailbox message has a durable delivery lifecycle: pending, delivered,
acknowledged, or failed. Delegation atomically assigns a task and writes the
recipient message. The scheduler wakes the recipient in its own Agent Chat,
respects the Team's maximum parallel-run setting, and retries failed delivery a
finite number of times. A Team activity event is a structured coordination
projection; it is not a replacement for the member's Chat transcript.

A Team Task Attempt binds one concrete task assignment to one teammate and,
once awakened, one ACP run. It persists queued, running, missing-report,
submitted, completed, and failed states. Failures use a provider-neutral
classification while retaining the original diagnostic. A completed Agent turn
without a structured result receives one durable reminder; repeating that
condition fails the Attempt so the Leader can retry or reassign the task.

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
teammate budget.

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
than a Kubecode model abstraction. Teammate removal is a Leader-only lifecycle
transition: the ACP actor is disconnected, active assignments return to
pending, and both provider-native and Kubecode Session records are deleted while
Project files remain untouched. The Leader first discovers durable member IDs
through `team_list_members`, then invokes `team_remove_teammate`. The ordinary
Session API rejects teammate deletion before disconnecting its actor; the
browser does not expose that action. Deleting the fixed Leader instead disbands
the Team and applies the deletion lifecycle to every member.

## Turn checkpoint

A turn checkpoint stores optional before/after Git tree IDs for one run. Trees
are captured with a private alternate index, so staging remains user-owned.
Shared-workspace restoration requires an after-tree fingerprint match; a
mismatch is a conflict, not an overwrite. A legacy run without a complete
checkpoint cannot participate in an explicit safe file restore. Chat revision
creation remains available because it never changes Project files.

## Composer reference

A Composer reference is a project-relative `@path` token selected through the
same lazy file tree used by the workbench. Agent skills and commands remain
Agent-owned: the UI renders ACP `available_commands` and inserts the selected
native slash command instead of maintaining a Kubecode-only command catalog.

## Session and run

A Session is a durable relationship between one Agent Session and one Agent. It owns
the provider Session ID, manual and Agent titles, retained ACP state, archive
state, activity timestamps, and an ordered Session event history. A Session may
reference a parent as a provider-native fork or subagent; imported subagent
transcripts may be marked read-only. The user-facing `Delete` operation requests
ACP provider deletion first and removes Kubecode state only after the Agent
accepts it. OpenCode may use its native `session delete` command when its ACP
adapter lacks delete; ACP close is not deletion. Sessions without provider
identity are deleted locally.

A run is one user prompt and its normalized Agent events. A Session has at most
one active run, while different Sessions can run concurrently. Runs may be
running, waiting for input, completed, failed, cancelled, timed out, or
interrupted.

## ACP actor

`AgentRuntime` owns one actor per connected Session. The actor serializes
prompts, polls mode and configuration changes while a prompt is active, and
normalizes ACP updates into durable Kubecode events. It resumes an existing
provider Session when possible and falls back to loading it.

Agent discovery and ACP adapter discovery are separate. CLI authentication,
models, and provider settings remain external to Kubecode.

## Terminal

`TerminalManager` owns each PTY independently of any WebSocket. A terminal is
bound to a Project cwd and has a `regular`, `claude_code`, `codex`, or `opencode`
profile. A bounded byte buffer with monotonic cursors lets browsers reconnect
without restarting the process.

The frontend's terminal group and recursive split tree are presentation state;
each leaf still refers to an independent server PTY.

## Workspace event

A workspace event is a durable, globally ordered metadata notification. One SSE
connection carries Project, Session, run, file, Git, and terminal changes. The
client retains a bounded ordered window rather than only the newest event.

## Details workbench

The default Details overview has two independently collapsible trees:

- Changes: Git status and file diffs with stage, unstage, discard, init, and commit.
- Files: a lazy Project tree and CodeMirror editor.

Opening a file changes context without replacing the Agent Session. File writes
use a revision token and return HTTP 409 on stale content.

## Workspace attention

Global Session summaries project durable state needed by navigation: Project,
Agent, title, latest run status, activity, archive state, parent relation, and
optional durable Team identity (`team_id` and `team_role`). The browser combines
these summaries with new workspace events to render cross-Project
input-required navigation. Rich Team snapshots remain a separate task/member
view and are independently recoverable after a partial load or SSE reconnect.

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
theme, UI font, code font, and terminal font. Semantic CSS tokens feed the
workspace, CodeMirror, and xterm so theme changes do not reconnect a PTY.
