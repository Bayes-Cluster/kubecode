# AGENTS.md — Kubecode

## Product boundary

Kubecode is a browser-based, project-oriented AI coding workspace for
Kubeflow. The supported runtime is the React frontend in `src/`, the Rust server
in `server/`, and the container assets in `deploy/`. Do not reintroduce Tauri,
desktop release workflows, hosted model providers, or agents other than Claude
Code, Codex, and OpenCode without an ADR.

A Project is an absolute server path. Removing a Project only unregisters it;
never delete the directory. Removing a Session only removes Kubecode's record;
never delete provider-native history.

## Development workflow

- Read the task and relevant active ADRs before structural work.
- Use Red → Green → Refactor for behavior changes. Pure CSS changes are exempt.
- Prefer behavioral tests close to the changed code.
- Use existing shadcn components and semantic CSS tokens for UI work.
- Keep all filesystem access behind `WorkspaceService`.
- Keep browser routes compatible with `NB_PREFIX`.
- Preserve user changes in a dirty worktree.

## Required checks

Before committing code, run the checks relevant to the change:

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

Frontend line, function, branch, and statement coverage must remain at least
70%. Add a regression test for bugs whenever practical.

## Localization

All user-facing UI copy must come from `src/lib/locales/en.json` and be present
in every locale listed by `lara.yaml`.

```bash
pnpm l10n:translate
pnpm l10n:validate
```

Use `l10n:translate:force` only when intentionally regenerating existing
translations.

## Security

- Never expose arbitrary server paths after Project registration; use Project
  IDs and validated relative paths.
- Never put provider credentials, prompt content, filenames, or file contents in
  analytics events.
- Fix new Critical and High static-analysis findings before release.
- Do not silence lint or type rules to pass a gate.

## Documentation

Update `docs/ARCHITECTURE.md` or `docs/ABSTRACTIONS.md` for changes to server
services, API boundaries, data models, Session semantics, terminal ownership, or
deployment. Create a new ADR for a new dependency, platform target, persistence
strategy, core abstraction, or cross-cutting pattern. Do not edit an accepted
ADR; supersede it.

## Git

Use conventional commit prefixes such as `feat:`, `fix:`, `refactor:`, `test:`,
and `docs:`. Never bypass hooks with `--no-verify`.
