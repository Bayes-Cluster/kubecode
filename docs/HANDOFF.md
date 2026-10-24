# Hand-off: official components across the workspace (#254)

This note closes the UI programme under issue #254 (with #229). It says what
was done, which contracts now hold, what remains as a documented exception, and
what is still open. The row-by-row record is
[design/ui-migration-inventory.md](design/ui-migration-inventory.md).

## The programme

| Slice | Issue | Scope | ADR |
| --- | --- | --- | --- |
| A | #255 | Shared foundation, inventory, CSS ownership check | [0247](adr/0247-official-components-own-base-appearance.md) |
| B | #256 | Shell, navigation, inspectors, global interactions | [0248](adr/0248-workspace-shell-on-official-sidebar-sheet-and-resizable.md) |
| C | #257 | General and DM conversation and composer | [0249](adr/0249-general-and-dm-conversation-on-official-components.md) |
| D | #258 | Search, references, attachments, evidence | [0250](adr/0250-workspace-readers-on-official-command-and-attachment.md) |
| E | #259 | Tasks, reviews, Needs you, execution feedback | [0251](adr/0251-tasks-reviews-and-attention-on-official-components.md) |
| F | #260 | Members, setup, settings | in 0248–0251 and the inventory |
| G | #261 | Session and Team execution views | [0253](adr/0253-session-and-team-execution-views-on-official-components.md) |
| H | #262 | File, Git, terminal and research utilities | [0252](adr/0252-file-git-terminal-and-research-utilities-on-official-components.md) |
| I | #263 | Route audit, cleanup, hand-off | [0254](adr/0254-route-audit-closes-the-official-component-migration.md) |

## Contracts that now hold

- **Official components own their base appearance** (ADR 0247). Product CSS
  lays out elements it owns. `pnpm lint` runs `scripts/check-css-ownership.mjs`,
  which fails on any new `[data-slot=…]`, `[cmdk-…]`, `[data-radix-…]` or
  `!important` rule. `scripts/css-ownership-baseline.json` holds 10 entries,
  all exceptions: overlay zoom compensation (5), no text selection on controls
  (2), the xterm viewport (1) and `prefers-reduced-motion` (2).
- **Shared vocabulary** (`docs/design/ui-shared-contract.md`): `ViewHeader`,
  `IconButton`, `StatusBadge`, `MemberIdentity`/`MemberAvatar`,
  `ReferenceChip`, `PauseButton`/`StopButton`, `MoreActions`,
  `InspectorPanel`. Use them before adding markup.
- **CLI**: `components.json` lists only `@ai-elements`; `@shadcn` is built in.
  `pnpm dlx shadcn@4.22.1 info` must print the configuration.
- **Touch**: icon controls meet `--ws-touch-target` (44 px on coarse
  pointers) through `IconButton` or `kubecode-touch-target`.
- **Locales**: every key in all 21 catalogs; `pnpm l10n:validate` also fails
  when a sentence is still the English text.
- **Patterns**: a clickable card is a `Card` with one native button; an
  inspector history is a named region of `ItemGroup`/`Item`; a reader inside
  a titled panel does not repeat the panel's title (`titledByHost`).

## Documented exceptions

These stay custom on purpose. Each has its evidence in the inventory.

- Specialist engines: xterm terminal, CodeMirror editor and diff,
  react-virtuoso long lists, and the contenteditable mention engine inside the
  Session composer.
- Thin adapters: the non-modal in-flow inspector stack and the read-only
  legacy thread pane (no registry component parks a stack of details in
  flow), application-wide shortcuts, `ActionTooltip` focus recovery, the local
  `Attachment` used by `ReferenceChip`, the terminal navigator tree (needs
  tree semantics and sorting), and fixed-height virtualised Git rows.
- Semantic HTML that holds official parts: the task-only message reference
  list, the work inspector facts `dl`, message header layout.

## #263 audit: what changed

Fixed (with a regression test where behaviour changed):

- Start page: buttons named by their visible label; Agent readiness text
  left-aligned; the Files and Git panel and its toggle stay off until a
  Project exists.
- Runtime connection: the first stream open records the last successful sync,
  so Live is never shown next to "Never".
- Phone: Settings opened from the navigation Sheet closes the Sheet and shows
  a visible title row that owns the close button; the context Sheet's tab bar
  leaves room for the Sheet's close button; Members tabs, the defaults
  description, the Task next-step alert and the round pause control fit at
  320 px; the Resources section filter wraps instead of scrolling; small
  icon actions are touch-sized.
- Inspector headers wrap actions under a title instead of squeezing it to
  one letter; the Resources inspector no longer repeats the record header.
- Files and Git: Material icons without a light variant stay visible in light
  theme; change rows read from the left; one "Changes" heading; diff tabs say
  "(diff)"; Agent plan status is said in words; terminal close buttons show
  without hover; xterm no longer receives `cols/rows: undefined`.
- Official components replace the remaining handcrafted pieces: work board
  card, work inspector histories, reply citation, failed delivery,
  `ConversationIdentity`.
- An unnamed Team takes the localised name; the terminal can take at most
  60% of the height (200% zoom).
- Translations: 348 untranslated keys filled in 20 locales.

Cleanup: 982 unreferenced locale keys removed from all 21 catalogs; dead and
duplicated CSS removed from `kubecode.css` and `index.css`; the CSS baseline
went from 23 to 10 entries; `ws`, `@types/ws` and `esbuild` removed; the
composer reads the coarse pointer through the shared hook.

## Still open

- **Search "changed since these results" after load.** Reproduced: the
  project watcher emits `file_changed` with `{"full": true}` about one and
  five seconds after a Workspace opens (events traced on a fresh project), and
  a full rescan touches every file result. The fix belongs in the server
  watcher (which full rescans fire on open) or in a narrower client rule for
  full rescans; neither is in this slice.
- **Navigation width after a project exists.** Not reproduced at 1440 px with
  fresh storage (the sidebar is 280 px). The audit run probably restored a
  width remembered from an earlier, narrower viewport; no code change.
- **Session title bar below 360 px.** The agent glyph now gives way and the controls never shrink, but the title still has little
  room in the Team view at 320 px. Moving the Session controls out of the
  title bar on phones is a design change for a later issue.

## Pitfalls met on the way

- **The Session view is a lazy chunk.** `AgentSessionWorkspace.tsx` loads
  `session/SessionWorkspace` on first open. In Vitest a cold import takes
  about two seconds, longer than the one second a `findBy*` waits, so the
  first test in a file that opens a Session fails on a loaded machine (the
  pre-push gate, CI under coverage) and passes alone. Warm the chunk in a
  `beforeAll` (`await import('../session/SessionWorkspace')`) as
  `WorkspaceShell.test.tsx` does; do not raise the per-call timeout.
- **Smoke and walkthroughs must run a server built from the branch.** The
  #254 closeout walkthrough first ran against a prebuilt
  `kubecode-server` and reported the member-Session fix as still broken,
  because the new `GET /projects/{id}/sessions/{id}` route was not in that
  binary. Build with `cargo build --manifest-path server/Cargo.toml` from the
  worktree under test and point `KUBECODE_SERVER_BIN` at that output.
- **One gated push at a time.** The pre-push gate detaches the shared
  checkout at the branch under test. Two gates at once pushed one branch's
  commits under the other branch's name (PR #264). Run gates serially and
  compare `git ls-remote origin refs/heads/<branch>` with the intended
  commit before opening the PR.
- **A slice worktree shares `node_modules` with the main checkout** (a
  symlink). `pnpm remove` there would prune packages the other worktrees
  still import. Edit `package.json` and run
  `pnpm install --lockfile-only --ignore-scripts`; it rewrites the lockfile
  and leaves `node_modules` alone (check `.modules.yaml`'s mtime). The main
  checkout picks the removal up on its next `pnpm install` (#278).
- **streamdown forwards unknown props to its root `div`**, so a
  `data-testid` on `MessageResponse` lands on the rendered root, but
  `MessageResponse`'s memo compares only children, `isAnimating`,
  `className`, `components`, `controls` and `translations`: a prop that
  changes between renders is ignored. Keep forwarded props constant (#278).
- **Comparing two renders of the same markdown**: React's `useId` values
  (`id`, `for`, `aria-controls`, `aria-describedby`) differ between trees,
  and shiki highlights asynchronously. Strip those attributes and compare
  inside `waitFor`, as `src/kubecode/markdown/oneRenderer.test.tsx` does.
- **micromark's `singleDollarTextMath` is not pandoc's rule.** It renders
  "$5 and $10" and "$x$2" as formulas; the ADR 0229 §7 rules (no space inside
  the delimiters, no digit after the closing one) live in
  `src/kubecode/markdown/inlineMath.ts`, which every adapter must run.
  `@streamdown/math`'s `createMathPlugin` takes no KaTeX options; rebuild its
  `rehypePlugin` tuple to pass `maxSize`/`maxExpand`/`trust` (#278).
- **streamdown marks no root or paragraph.** `data-streamdown` sits on links,
  tables, strong and the like, never on the root `div` or `<p>`, so a
  selector on it misses prose; the adapters put `data-prose` on the root.
- **A paragraph that starts with raw HTML is one HTML block to marked**: with
  `skipHtml`, everything on that line (links included) becomes literal text.
  In a fixture, keep the raw-HTML attack and the link attack in separate
  paragraphs, or the link assertions test nothing (#278).

- **Timeouts under load are not failures.** The workstation is shared;
  other jobs push the load average past 12 on 7 cores, and the pre-push
  gate's Vitest run then times out four or five whole-Workbench route tests
  that take a second when idle (WorkspaceShell, App, ChannelWorkspace,
  ProjectFileTree). `testTimeout` is 30 s and testing-library's
  `asyncUtilTimeout` is 5 s for that reason; check `uptime` before blaming
  a change, and run the gate when no other heavy agent is building.

## Validation

Fixture validation only: unit tests, `pnpm test:coverage`, and the Playwright
smoke suite against `kubecode-server` with the fake Agents. No real-Agent run
was made in this slice, and nothing here claims real-Agent end-to-end
execution.
