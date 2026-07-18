# Installation and deployment

[Documentation](../README.md) · [简体中文](../zh-CN/guides/installation.md)

## Local development

Requirements:

- Node.js 22 or newer
- pnpm 10
- stable Rust
- Git
- optionally, an authenticated Claude Code, Codex, or OpenCode CLI

Install dependencies and start the Rust API:

```bash
pnpm install
pnpm dev:server
```

In a second terminal, start Vite:

```bash
pnpm dev
```

Open <http://127.0.0.1:5202>. Vite proxies API and terminal WebSocket traffic
to port 8888. Development state is written below `.local/`.

## Production-style local run

```bash
pnpm build
PERSISTENT_DIR="$PWD/.local/workspace" \
KUBECODE_STATE_DIR="$PWD/.local/state" \
KUBECODE_STATIC_DIR="$PWD/dist" \
PORT=8888 \
cargo run --manifest-path server/Cargo.toml
```

Open <http://127.0.0.1:8888>.

## Container image

```bash
docker build -f deploy/Dockerfile -t kubecode:local .
```

The production image includes:

- the built React application and `kubecode-server`;
- Claude Code, Codex, and OpenCode;
- the Claude and Codex ACP adapters;
- Git, tmux, ripgrep, SSH tools, and s6 initialization.

The pinned Agent and adapter versions are build arguments in
`deploy/Dockerfile`. Update them deliberately and verify the real-Agent smoke
test before publishing an image.

## Kubeflow Notebook

`deploy/kubeflow-notebook.yaml` contains a reference PVC and Notebook resource.
Before applying it:

1. publish or make your image available to the cluster;
2. replace `ghcr.io/example/kubecode:latest`;
3. set `NB_PREFIX` to the path assigned by your Kubeflow installation;
4. set `PERSISTENT_DIR` to the mounted user workspace;
5. adapt the PVC, namespace, security context, and resource requests to the
   cluster policy.

The image exposes port `8888`. `/healthz` and `/readyz` are available below the
configured base path.

## Persistent data

By default, the container stores workspace files under `PERSISTENT_DIR` and
Kubecode state under `$PERSISTENT_DIR/.state/kubecode`. The initialization
scripts also persist the supported Agent CLI configuration below
`$PERSISTENT_DIR/.state`.

Back up the mounted volume according to your cluster policy. Kubecode state
contains Session metadata and normalized Agent events; provider credentials
remain in the CLI-owned directories.

## Agent discovery

Kubecode scans the inherited `PATH`, common install locations, and login-shell
paths at server startup. Local development may override executable discovery:

```text
KUBECODE_CLAUDE_PATH
KUBECODE_CODEX_PATH
KUBECODE_OPENCODE_PATH
KUBECODE_CLAUDE_ACP_PATH
KUBECODE_CODEX_ACP_PATH
```

Install and authenticate each CLI using its official documentation. Never put
provider API keys in Kubecode configuration.

To validate a real adapter without sending a prompt:

```bash
KUBECODE_REAL_AGENT=opencode pnpm test:agents:real
```

Use `claude_code`, `codex`, or `all` to select another Agent.
