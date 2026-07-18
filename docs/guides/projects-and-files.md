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
