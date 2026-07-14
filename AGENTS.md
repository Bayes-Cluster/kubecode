# AGENTS.md — Tolaria App

## 1. Development Process

### Start working on a task

- Read task description and all comments fully
- For To Rework: the ❌ QA failed comment tells you exactly what to fix
- Check `docs/adr/` for relevant architecture decisions before structural choices
- Check `docs/ARCHITECTURE.md` and `docs/ABSTRACTIONS.md` for relevant structural information
- For UI tasks: study app visual language and components first. Prioritize reusing existing components, assets, and variables over recreating them.
- If working on a Todoist task, add a comment: `🚀 Starting work on this task. [Brief description of approach]`

### Commits & pushes

- Local work may happen on `main`, in detached HEAD worktrees, or in other temporary local states. The production path is still direct-to-main: final verified work is pushed to `origin/main`, with no PR branch flow.
- Commit every 20–30 min: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`
- Pre-commit is a lightweight lint gate only. Pre-push runs the full check suite (build + tests + coverage + core Playwright smoke), preferably on three Chunk sidecar lanes for automatic test/coverage work: frontend lint/build/coverage, Rust coverage, and Playwright smoke. The goal is lower wall-clock time than local hooks while keeping each heavy gate isolated; keep local Playwright mainly for authoring, focused reproduction, or sidecar outages.
- **A task is NOT done until `git push origin main` succeeds.** If the hook blocks: read the error, fix it (clippy, tests, coverage, build), commit the fix, push again. **⛔ NEVER use --no-verify**

### TDD (mandatory)

Red → Green → Refactor → Commit. One cycle per commit. For bugs: write failing regression test first, then fix. Exception: pure CSS/layout changes.

**Test quality (Kent Beck's Desiderata):** Isolated · Deterministic · Fast · Behavioral · Structure-insensitive · Specific · Predictive. Fix flaky tests first. Prefer E2E over unit tests for user flows.

### Localization (mandatory for UI copy)

All user-facing UI labels/copy must live in `src/lib/locales/en.json` and be translated into every target listed in `lara.yaml`. When adding or changing interface copy:

```bash
pnpm l10n:translate
```

Use `pnpm l10n:translate:force` only when intentionally regenerating existing translations. Commit `src/lib/locales/*.json`, `lara.yaml`/`lara.lock` changes if produced, and verify placeholders/product names stayed intact.

### Product analytics (mandatory for meaningful features)

New features should almost always emit a PostHog event so we can see whether users actually discover and use them. Skip instrumentation only for very small changes where a dedicated event would create noise. Use clear, stable event names, avoid PII or note content, and include only safe metadata that helps evaluate adoption and failures.

When adding or changing a meaningful user-facing feature, include the event name(s) in the Todoist completion comment alongside QA and docs. If intentionally not instrumenting a feature, explain why in the completion comment.

### Code quality (mandatory)

Keep changes small, typed, tested, and easy to review. Never add `// eslint-disable`, `#[allow(...)]`, or `as any` to silence a quality failure. Refactor code when lint, type checking, tests, coverage, or security analysis exposes a structural problem.

### Security scan with Codacy (mandatory)

Use Codacy as a security and static-analysis gate before a task is considered releasable.

- Prefer the Codacy MCP inside Codex to inspect repository/file issues for every touched code file.
- If MCP is unavailable, use the local CLI wrapper, e.g. `.codacy/cli.sh analyze <path> --format sarif`; choose the relevant tool when useful (`eslint`, `opengrep`, `trivy`, `lizard`).
- **Always fix Critical and High severity findings introduced by your change.** Do not move the task to In Review with new Critical/High Codacy issues.
- Review Medium findings. Fix them when they are real defects or security-sensitive; otherwise explain why they are acceptable in the completion comment.
- Never silence a Codacy rule just to pass the scan. Prefer small code changes that remove the finding.

### Check suite (runs on every push)
```bash
pnpm lint && npx tsc --noEmit && pnpm test && pnpm test:coverage  # frontend ≥70%
cargo test && cargo llvm-cov --manifest-path src-tauri/Cargo.toml --no-clean --fail-under-lines 85
```

Coverage is a release gate, not a vanity metric:
- Frontend coverage must stay ≥70%.
- Rust line coverage must stay ≥85%.
- For bug fixes, add a regression test when practical.
- For new behavior, add targeted coverage close to the changed code; do not rely only on broad E2E coverage.

### UI and native QA

**Phase 1 — Playwright (only for core user flows):**

Write Playwright test in `tests/smoke/<slug>.spec.ts` only if feature touches: vault open, note create/save/delete, search, wikilink navigation, git commit/push, conflict resolution. Tag a test with `@smoke` only if it protects a core pre-push workflow. Do NOT tag cosmetic or mock-heavy checks — keep those in the full regression lane. Prefer `.chunk/run-playwright-smoke.sh` on a Chunk sidecar for the curated smoke lane because local Playwright is expensive; keep `pnpm playwright:smoke` available for focused local reproduction. The curated smoke suite must stay under **5 minutes** when sharded on sidecars; use `pnpm playwright:regression` for the full Playwright pass.

```bash
pnpm dev --port 5201 &
sleep 3
BASE_URL="http://localhost:5201" npx playwright test tests/smoke/<slug>.spec.ts
```

**Phase 2 — Native app QA:**

```bash
pnpm tauri dev &
sleep 10
bash ~/.openclaw/skills/tolaria-qa/scripts/focus-app.sh laputa
bash ~/.openclaw/skills/tolaria-qa/scripts/screenshot.sh /tmp/qa-native.png
```

Use computer-use/browser-control style interaction for native UI QA when available: click, hover, drag, select, scroll, and type the way a real user would with the mouse and trackpad. For every UI feature, test the primary mouse-driven path first, then verify any relevant keyboard shortcut or keyboard-first workflow still works. Tolaria is still a keyboard-first app, but QA must not assume users only interact by keyboard.

Use `osascript` for app focus, keyboard shortcuts, and keyboard-specific checks. **⚠️ WKWebView:** `osascript keystroke` can be blocked inside editor content — use computer use for native editor interaction when possible, and rely on Playwright for deterministic text-input coverage. Write result as Todoist comment (✅ or ❌).

### Release-readiness checklist

Before pushing or moving a task to In Review, verify the release gates and add a **completion comment** to the Todoist task. The comment must include:

- What was implemented (a few lines covering logic and UX/UI).
- QA: what was tested and how (Playwright / native screenshot / osascript).
- Tests/coverage: commands run and final coverage result.
- Coverage commands passed (`pnpm test:coverage` and `cargo llvm-cov ... --fail-under-lines 85`) or the change is docs-only.
- Codacy: MCP/CLI scan summary; confirm no new Critical/High findings.
- Localization: any user-facing copy lives in `src/lib/locales/en.json`, `pnpm l10n:translate` was run, and `pnpm l10n:validate` passes. If no copy changed, say “Localization: no UI copy changes”.
- PostHog: meaningful new user actions/events are instrumented with safe metadata; noisy/minor changes explicitly say “PostHog: no event needed because …”.
- Refactoring: any files refactored to keep the change maintainable, or "none needed".
- ADRs: any new/updated ADRs, or "none".
- Docs: any updated docs (`ARCHITECTURE.md`, `ABSTRACTIONS.md`, etc.), or "none".
- Demo vault dirt checked: `git status --short -- demo-vault demo-vault-v2` is empty unless fixture changes are intentional.

### ADRs & docs

ADRs live in `docs/adr/`. Create in the same commit as the code. Never edit existing — create a new one that supersedes. Use `/create-adr`. **When:** new dependency, storage strategy, platform target, core abstraction, cross-cutting pattern. **Not for:** bug fixes, styling, refactors.

After any Tauri command, new component/hook, data model change, or new integration: update `docs/ARCHITECTURE.md`, `docs/ABSTRACTIONS.md`, and/or `docs/GETTING-STARTED.md` in the same commit.

---

## 2. Product Rules

### Demo vault hygiene (`demo-vault/`, `demo-vault-v2/`)

Default to `demo-vault-v2/` for testing.

- Treat `demo-vault/` and `demo-vault-v2/` as disposable QA fixtures unless the task explicitly changes demo content.
- If you create untracked notes, attachments, or other temporary files there for testing, delete them before the task is complete.
- If you modify tracked demo-vault files only to test or QA behavior, revert those edits before the final commit.
- Before declaring a task done, make sure `git status --short -- demo-vault demo-vault-v2` is empty unless demo fixture changes are part of the task.
- If a fresh run starts and the only local dirt is inside `demo-vault/` or `demo-vault-v2/`, clean those paths first and continue. That case is recoverable QA residue, not a blocker.

### User vault (`~/Laputa/`)

Default to `demo-vault-v2/`. If you must use `~/Laputa/` for testing:
- **Never commit or push** any test notes to the remote vault
- **Delete all test notes from disk** when done — do not leave untitled or temporary notes on the filesystem. Run `cd ~/Laputa && git checkout -- . && git clean -fd` to restore the vault to its last committed state.
- **Rationale:** test notes pollute the local vault over time, making it a collection of nonsensical untitled files. The vault must stay clean on disk, not just on the remote.

### UI components — mandatory rules

**Always use shadcn/ui components.** Never use raw HTML form elements (`<input>`, `<select>`, `<button>`, native `<input type="date">`, etc.) for user-facing UI. Every interactive element must use the shadcn/ui equivalent:

| Need | Use |
|---|---|
| Text input | `Input` from shadcn/ui |
| Dropdown/select | `Select` from shadcn/ui |
| Date picker | `Calendar` + `Popover` from shadcn/ui (NOT native `<input type="date">`) |
| Button | `Button` from shadcn/ui |
| Autocomplete/combobox | Reuse existing combobox components from the app (check `src/components/`) |
| Wikilink picker | Reuse the wikilink autocomplete component already used in the editor and Properties panel |
| Emoji picker | Reuse the emoji picker component already used for note/type icons |
| Color picker | Reuse the color swatch picker used for type customization |
| Toggle/switch | `Switch` or `ToggleGroup` from shadcn/ui |
| Dialog/modal | `Dialog` from shadcn/ui |

**When in doubt:** search `src/components/` for an existing component before building new. **Visual language:** all new UI must feel native to Tolaria — if it looks like a browser default, it's wrong.

---

## 3. Reference

### macOS / Tauri gotchas

- `Option+N` → special chars on macOS. Use `e.code` or `Cmd+N`
- Tauri menu accelerators: `MenuItemBuilder::new(label).accelerator("CmdOrCtrl+1")`
- `app.set_menu()` replaces the ENTIRE menu bar — include all submenus
- `mock-tauri.ts` silently swallows Tauri calls — not a substitute for native testing

### QA scripts

```bash
bash ~/.openclaw/skills/tolaria-qa/scripts/focus-app.sh Tolaria
bash ~/.openclaw/skills/tolaria-qa/scripts/screenshot.sh /tmp/out.png
bash ~/.openclaw/skills/tolaria-qa/scripts/shortcut.sh "command" "s"
```

### Diagrams

Prefer Mermaid (`flowchart`, `sequenceDiagram`, `classDiagram`, `stateDiagram-v2`). ASCII only for spatial wireframe layouts.
