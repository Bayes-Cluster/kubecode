# ADR 0169: Terminal groups and browser snapshots

## Status

Accepted

## Context

The first browser Terminal implementation exposed a single recursive split tree.
It did not distinguish long-lived terminal collections from panes, lost visible
scrollback when React remounted xterm, and removed a PTY as soon as its process
exited. Those behaviors made Project switching, dock folding, and multi-terminal
work differ from the familiar VS Code and Zed model.

## Decision

- The Terminal dock starts folded. Its toolbar includes an internal fold control,
  and the top toolbar can reopen it.
- One Terminal tab represents one group. A group owns one or more split leaves;
  split-right and split-down inherit the active leaf's shell or Agent TUI profile.
- Group order, active leaves, split topology, and ratios persist per Project in
  `localStorage`. Existing single-tree layouts migrate into one group.
- xterm serializes a bounded browser-session snapshot containing output, server
  cursor, dimensions, and scroll position. On remount it paints the snapshot
  first and then requests newer server bytes from that cursor.
- A terminal process has explicit `running` and `exited` states. The server keeps
  exited terminals listable until the user closes them, sends final buffered
  output before the exit status frame, and exposes rename through the HTTP API.
- Terminal process and output persistence ends when the Kubecode server or Pod
  restarts. Durable server-side terminal multiplexing is outside this decision.

## Consequences

Users can fold the dock, switch Projects, refresh the browser, rename and reorder
groups, and return to the same split workspace without losing the current server
PTY. Process exits are visible and restartable rather than silently disappearing.
Browser snapshots are deliberately bounded and contain terminal output, so they
use session-scoped storage and are removed when a terminal is closed.
