# Terminal and TUI Sessions

[Documentation](../README.md) · [简体中文](../zh-CN/guides/terminal.md)

Kubecode provides reconnectable Project terminals in the bottom panel. A
terminal can run a regular shell or the native TUI of Claude Code, Codex, or
OpenCode.

## Create and manage terminals

Open the bottom panel and use the terminal actions to:

- create a shell or Agent TUI;
- switch between PTYs in the side list;
- rename or close a terminal;
- split the active terminal horizontally or vertically;
- resize split panes and the entire bottom panel;
- reconnect to a live PTY after changing Project or Session.

Terminals belong to a Project, not to the selected Agent Session. Switching
between Sessions in the same Project must not create another terminal.

## Split behavior

Each terminal group stores a split tree. Split dividers remain visible and
draggable even though the panel header and outer chrome are intentionally
minimal. Pane ratios are free-form rather than restricted to fixed presets.

Closing a pane collapses its parent split. Closing the last PTY closes the
terminal group and allows the bottom panel to collapse.

## Process exit

Entering `exit` or sending `Ctrl+D` normally terminates the shell with exit code
0. Kubecode then closes the corresponding PTY entry after receiving the
process-exit event. A terminal that exits with a non-zero code remains visible
with its exit status and scrollback so the failure can be inspected. It can be
closed or restarted in its original Session workspace.

Agent TUIs follow the same lifecycle. Their authentication and interactive
commands are implemented by the Agent CLI, not Kubecode.

## Persistence boundary

Kubecode reconnects browser views to PTYs while the Rust server remains alive.
Terminal process and scrollback persistence end when the server or Notebook Pod
restarts. Agent conversation persistence is separate and continues through the
Session store and provider history.

## Theme and font

Terminal colors follow the selected Kubecode theme. Terminal font is configured
independently in **Settings → General → Appearance**; the font must be installed
in the user's browser environment.
