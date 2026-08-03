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
The Files and Git views remain authoritative on demand, and the manual refresh
control is always available. Reconnecting always requests a fresh full view for
every Project you have open.

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
