<p align="center">
  <img src="./public/logo.svg" width="96" height="96" alt="Kubecode logo">
</p>

<h1 align="center">Kubecode</h1>

<p align="center">
  A project-oriented AI coding workspace for Kubeflow.
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/Bayes-Cluster/kubecode/actions/workflows/ci.yml"><img src="https://github.com/Bayes-Cluster/kubecode/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0--or--later-5B5CE2" alt="AGPL-3.0-or-later license"></a>
</p>

<p align="center">
  <img src="./docs/assets/brand/kubecode-social-preview.png" alt="Kubecode brings Claude Code, Codex, and OpenCode into Kubeflow workspaces">
</p>

Kubecode turns a directory in a single-user Kubeflow Notebook into a durable AI
coding workspace. Run local coding agents, keep long-lived Sessions, coordinate
Agent Teams, inspect Git changes, edit files, and manage reconnectable terminals
without leaving the browser.

Kubecode currently supports these local Agent CLIs:

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- [Codex](https://developers.openai.com/codex/cli)
- [OpenCode](https://opencode.ai)

Authentication, model selection, and provider credentials remain owned by each
CLI. Kubecode discovers local executables and communicates with them through
ACP; it does not proxy prompts through a hosted model service.

## Why Kubecode

| AI Sessions | Team workflows | Complete workspace |
| --- | --- | --- |
| Durable ACP conversations with native modes, models, commands, plans, permissions, questions, resume, and fork when supported. | A fixed Leader coordinates independent teammates, durable tasks, mailbox delivery, permission review, and optional independent verification. | Project files, CodeMirror editing, Git changes, diffs, shell or Agent TUI terminals, free-form splits, themes, and notifications. |

## Workspace model

- **Project** — an absolute, canonical directory registered on the Kubecode
  server.
- **Session** — a durable conversation connected to one local Agent and one
  Project.
- **Team** — a Leader-governed group of independent Agent Sessions with
  persistent tasks and messages.
- **Terminal** — a reconnectable shell or native Agent TUI PTY.

Deleting a Project only unregisters it. Deleting a Session removes only
Kubecode's local record. Kubecode never deletes the Project directory or
provider-native Session history.

## Quick start

### Requirements

- Node.js 22+
- pnpm 10
- stable Rust
- Git
- at least one installed and authenticated supported Agent CLI

```bash
pnpm install
pnpm dev:server
```

In a second terminal:

```bash
pnpm dev
```

Open <http://127.0.0.1:5202>. Local development state is stored under
`.local/`.

For a production-style local run:

```bash
pnpm build
PERSISTENT_DIR="$PWD/.local/workspace" \
KUBECODE_STATE_DIR="$PWD/.local/state" \
KUBECODE_STATIC_DIR="$PWD/dist" \
PORT=8888 \
cargo run --manifest-path server/Cargo.toml
```

## Container and Kubeflow

Build the production image:

```bash
docker build -f deploy/Dockerfile -t kubecode:local .
```

The image contains the React application, Rust server, supported Agent CLIs,
Claude and Codex ACP adapters, and s6 process initialization.
[`deploy/kubeflow-notebook.yaml`](deploy/kubeflow-notebook.yaml) is a reference
Notebook manifest; replace its example image and configure `NB_PREFIX` for your
Kubeflow route.

See [Installation and deployment](docs/guides/installation.md) for persistent
storage, runtime variables, health checks, and CLI setup.

## Architecture

```mermaid
flowchart LR
  Browser[React workspace] -->|HTTP + SSE| Server[Rust / Axum]
  Browser -->|WebSocket| Terminal[Terminal PTYs]
  Server --> Workspace[Project filesystem]
  Server --> State[(SQLite state)]
  Server --> Git[Local Git]
  Server --> ACP[ACP Session actors]
  ACP --> Claude[Claude Code]
  ACP --> Codex[Codex]
  ACP --> OpenCode[OpenCode]
  ACP <-->|MCP| Team[Team control plane]
```

The Rust server is the trust boundary. Browser requests use Project IDs and
validated relative paths; filesystem access stays inside registered Project
roots.

## Documentation

### User guide

- [Documentation home](docs/README.md)
- [Installation and deployment](docs/guides/installation.md)
- [Projects, files, and Git](docs/guides/projects-and-files.md)
- [Agent Sessions](docs/guides/agent-sessions.md)
- [Team Sessions](docs/guides/team-sessions.md)
- [Terminal and TUI Sessions](docs/guides/terminal.md)
- [Configuration](docs/guides/configuration.md)
- [Troubleshooting](docs/guides/troubleshooting.md)

### Developer documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Core abstractions](docs/ABSTRACTIONS.md)
- [Architecture Decision Records](docs/adr/README.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Repository layout

```text
src/kubecode/    Browser workspace and API client
src/components/  Shared UI and Agent transcript primitives
server/          Axum API, ACP runtime, terminal, Git, and workspace services
deploy/          Container and Kubeflow deployment assets
tests/smoke/     Browser workspace smoke tests
docs/            User, developer, and architecture documentation
```

## Quality checks

```bash
pnpm lint
npx tsc --noEmit
pnpm test
pnpm test:coverage
cargo test --manifest-path server/Cargo.toml
cargo clippy --manifest-path server/Cargo.toml -- -D warnings
cargo fmt --manifest-path server/Cargo.toml -- --check
pnpm playwright:smoke
pnpm docs:check
```

## License and origin

Kubecode is licensed under
[AGPL-3.0-or-later](LICENSE). It began as a derivative of the open-source
Tolaria project and retains attribution through the repository history and
license.
