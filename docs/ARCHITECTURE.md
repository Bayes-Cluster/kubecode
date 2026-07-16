# Architecture

Kubecode is a browser application backed by a standalone Rust server. The
active production boundary is defined by ADRs 0161–0173.

## Runtime topology

The React client is served below `NB_PREFIX`, which allows the same image to run
at a Kubeflow Notebook subpath. `KubecodeApi` derives HTTP, SSE, and WebSocket
routes from the current browser pathname. Health probes remain unprefixed at
`/healthz` and `/readyz`.

The Axum server composes five services:

- `WorkspaceService` registers Project roots and contains filesystem access.
- `AgentStore` persists Sessions, runs, normalized events, and workspace events.
- `AgentRuntime` owns long-lived ACP actors for Claude Code, Codex, and OpenCode.
- `TerminalManager` owns reconnectable PTYs independently of browser sockets.
- `GitService` performs Project-scoped Git operations without shell interpolation.

SQLite is application metadata, not project content. Project files remain on
disk at their original absolute paths.

A Project may opt into Workspaces. New Agent Sessions can then execute either
at the shared Project root or in a server-managed Git worktree below the private
state directory. The chosen cwd is durable and is used by every ACP lifecycle
operation, not only the first prompt. Existing and imported Sessions remain
shared unless the user explicitly creates an isolated Session.

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

ACP capabilities drive the UI. Commands, fork, modes, configuration, plans,
permissions, elicitation, and usage appear only when advertised by the active
Agent. Kubecode does not implement a second permission-mode abstraction.

Session deletion removes only Kubecode's record. Project deletion unregisters
the Project and does not modify its directory.

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
