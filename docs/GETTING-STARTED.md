# Getting started

## Prerequisites

- Node.js 22+
- pnpm 10
- Stable Rust
- Git
- Optional: authenticated Claude Code, Codex, or OpenCode CLI

## Development

```bash
pnpm install
pnpm dev:server
```

In a second terminal:

```bash
pnpm dev
```

Open `http://127.0.0.1:5202`. The Rust server stores local development state
under `.local/`; Vite proxies API and WebSocket traffic to port 8888.

## Production build

```bash
pnpm build
PERSISTENT_DIR="$PWD/.local/workspace" \
KUBECODE_STATE_DIR="$PWD/.local/state" \
KUBECODE_STATIC_DIR="$PWD/dist" \
cargo run --manifest-path server/Cargo.toml
```

## Important paths

```text
src/kubecode/       Product-specific React code
src/components/     Reused UI and transcript primitives
server/src/         Rust services and API
server/tests/       Rust integration tests
tests/smoke/        Browser smoke test
deploy/             Container and Kubeflow resources
docs/adr/           Active architectural decisions
```

## Verification

```bash
pnpm lint
npx tsc --noEmit
pnpm test
pnpm test:coverage
cargo test --manifest-path server/Cargo.toml
cargo clippy --manifest-path server/Cargo.toml -- -D warnings
cargo fmt --manifest-path server/Cargo.toml -- --check
pnpm playwright:smoke
```
