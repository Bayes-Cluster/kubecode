# Projects, files, and Git

[Documentation](../README.md) · [简体中文](../zh-CN/guides/projects-and-files.md)

## Projects are server paths

A Kubecode Project is an existing absolute directory on the server. Choose
**Add Project**, browse the server filesystem, and select a directory. Kubecode
canonicalizes the path before registration.

The browser receives a Project ID after registration. Subsequent file, Git,
Terminal, and Session requests use that ID rather than exposing arbitrary
server paths.

Removing a Project unregisters it from Kubecode. It never deletes the directory
or any file below it. Sessions that still belong to the Project should be
removed or moved intentionally before unregistering the Project.

## Files and editor

The Explorer provides:

- a lazy Project file tree;
- file and folder creation;
- rename and delete actions;
- file search and path references;
- lightweight CodeMirror editing;
- configurable code font and optional auto-save.

All operations are relative to the registered Project root. Symlinks and path
components are validated by the server; requests that escape the root are
rejected.

The editor is intentionally lightweight. Use a Terminal or another IDE when you
need language-server features, debugging, or extension ecosystems.

## Automatic refresh

Kubecode watches each registered Project directory so the Explorer and Git
Changes stay current when files change outside the editor. Changes made by a
Terminal, Git, an Agent, or another process on the server are surfaced as
invalidation events instead of requiring a manual refresh.

Watching is best-effort and intentionally never a source of authoritative data.
The server coalesces a burst of activity before notifying the browser, and it
falls back to refreshing the whole Project when it cannot classify a change or
its notifications overflow. Adding and removing a Project updates the watch
automatically; a failed watch never hides the Project, and Kubecode retries it.
An ordinary event names validated Project-relative entries and refreshes only
their loaded parent directories; a cross-directory rename names both entries so
both parents and affected descendant caches are reconciled. `.git` metadata
activity produces a Git-only event, while an ordinary event also marks Git
status dirty. Watcher queue, backend, path, or batch overflow emits a full
invalidation. Events contain no absolute server paths, file contents, or
mutation instructions.

The Files and Git views remain authoritative on demand, and the manual refresh
control is always available. Reconnecting, initial SSE open, watcher recovery,
or a full invalidation marks all loaded directories stale and refreshes Git
without replaying paths. A failed directory read keeps its rows marked stale and
shows a recoverable error; manual refresh retries it. A failed diff remains in a
retryable state, and a truncated status shows only its bounded prefix with a
warning.

## Git Changes

For Git repositories, the Changes tree supports:

- status refresh;
- unstaged and staged diffs;
- stage and unstage;
- discard;
- repository initialization;
- commits.

Click a changed file to open its diff. Git paths are validated relative to the
Project, and Git operations are executed without interpolating paths into a
shell command.

Status is bounded to the first 10,000 complete records or 1 MiB. The response
marks a truncated list as a prefix; reduce the repository changes and refresh
to inspect the remainder. Individual staged, unstaged, and untracked diffs are
bounded to 2 MiB. Binary, oversized, and unsupported diffs remain explicitly
unavailable instead of being silently truncated.

Status invalidations wait 250 milliseconds, allow one active status request per
Project, and schedule one follow-up if more activity arrives while it runs.
Mutation responses apply immediately and their echoed events are coalesced.
Files and each Git group use the simple DOM path through 200 visible rows and a
virtualized list above 200. Virtualization keeps stable path keys and the tree
keyboard and screen-reader semantics; it limits mounted rows, not the available
selection or expansion state.

Discarding changes is destructive and cannot be undone by Kubecode. Review the
diff and confirm that the path belongs to the intended Project.

## Optional Workspace mode

A Session can run in the Project directory or in a server-managed Git worktree.
Workspace mode isolates file changes between Sessions while preserving access
to the same repository history.

Disable Workspace mode when Sessions should work directly in the original
Project. Kubecode migrates managed Session workspaces back through its
checkpoint workflow; resolve any reported conflicts before continuing.

## Path references

Use the Composer **+** menu or type an `@path` reference to attach Project
context. Kubecode validates references before sending them to the Agent. The
Agent still decides how to read or use the referenced file.

## #56 Verification Map

The integrated delivery maps the parent issue's acceptance criteria to these
owning tests or manual checks:

| #56 criterion | Verification |
| --- | --- |
| Kubecode mutations refresh affected loaded parents | `server/tests/api.rs` entry mutation event test; `ContextWorkbench.test.tsx` scoped refresh test |
| Agent, Terminal, Git, and external edits appear | `server/src/project_watcher.rs` external write test; manual Agent/Terminal edit check |
| Cross-directory rename refreshes both parents | `ProjectFileTree.test.tsx` cross-directory rename test; `server/tests/workspace.rs` rename test |
| Burst activity is bounded and coalesced | watcher coalescing test; `useGitStatusController.test.tsx` burst and single-flight tests |
| Queue/path overflow becomes full invalidation | watcher 257-path and overflow-flag tests; backend-error recovery test |
| SSE reconnect reconciles Files and Git without paths | `ContextWorkbench.test.tsx` reconnect reconciliation test; `useWorkspaceEventStream.test.tsx` reconnect tests |
| Stale directory, status, and diff results are discarded | `ProjectFileTree.test.tsx`, `useGitStatusController.test.tsx`, and `ContextWorkbench.test.tsx` stale-response tests |
| Porcelain v2 status records retain all required identities | `server/src/git.rs` parser test and `server/tests/git.rs` status, conflict, and submodule tests |
| Conflict, Staged, and Changes use the correct columns | `ContextWorkbench.test.tsx` projection test |
| Large status and diff reads remain bounded and recoverable | `server/tests/git.rs` bounded status/diff tests; localized browser state tests |
| Untracked diffs are generated outside the browser | `ContextWorkbench.test.tsx` asserts `readFile` is not used; `server/tests/git.rs` untracked diff test |
| Large Files and Git lists remain accessible | `ProjectFileTree.test.tsx`, `ContextWorkbench.test.tsx`, and `tests/smoke/virtualized-projections.spec.ts` |
| Unregister stops watching without deleting content | watcher unregister test; `server/tests/workspace.rs` unregister test |
| Analytics omit sensitive data | `AgentSessionWorkspace.test.tsx` analytics assertions; manual event-schema audit |
| Required repository gates pass | CI-equivalent commands listed in `AGENTS.md`; docs and localization checks run locally |

Manual checks use a temporary Project and remove only its Kubecode
registration. The Project directory and provider-native history are never
deleted by these checks.
