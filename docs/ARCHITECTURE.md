# Architecture

Kubecode is a browser application backed by a standalone Rust server. The
active production boundary is defined by ADRs 0161–0171.

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

## Browser workspace

`src/kubecode/App.tsx` renders a Project rail, Session sidebar, primary Agent
timeline/composer, a Changes/Files/CodeMirror context pane, and a Terminal dock.
All three surrounding panels are resizable and independently collapsible.

The terminal dock manages independent shell or Agent TUI PTYs. Its recursive
split tree and split ratios live in browser state; PTY processes, output cursors,
and lifecycle state live on the server. Browser refresh can restore serialized
xterm output and replay newer bytes from the server cursor.

## Agent sessions

The server discovers exactly three CLIs: Claude Code, Codex, and OpenCode.
Claude and Codex use pinned ACP adapters; OpenCode exposes ACP natively. Each
Session actor stays connected across prompts and persists the provider Session
ID for resume or load after restart.

ACP capabilities drive the UI. Commands, fork, modes, configuration, plans,
permissions, elicitation, and usage appear only when advertised by the active
Agent. Kubecode does not implement a second permission-mode abstraction.

Session deletion removes only Kubecode's record. Project deletion unregisters
the Project and does not modify its directory.

## Event model

One global SSE stream multiplexes Session, run, file, Git, and terminal metadata
events. Events have monotonically increasing IDs so reconnecting clients can
resume. PTY bytes use dedicated WebSockets because terminal streams have
different buffering and cursor semantics.

## Deployment

`deploy/Dockerfile` builds the React client and Rust server, installs the three
supported CLIs and ACP adapters, and uses s6 for persistent CLI configuration.
`deploy/kubeflow-notebook.yaml` demonstrates a PVC-backed Notebook deployment.
