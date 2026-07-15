# ADR 0170: Unified layout controls and Project file tree

## Status

Accepted

## Context

Independent collapse buttons in the Session sidebar, Terminal dock, and top bar
made the workspace state difficult to scan. Split terminal headers duplicated
the dock toolbar and consumed vertical space. The context Files view navigated
one directory at a time, hiding the Project hierarchy.

## Decision

- One three-button control in the global top-right toolbar owns the open state of
  the Session sidebar, Terminal dock, and context sidebar. Its filled regions
  show the current layout at a glance.
- The Terminal dock has one compact toolbar. Split leaves render xterm directly
  without their own headers. When multiple PTYs exist, terminal instances are
  managed by a resizable vertical list on the dock's right edge instead of toolbar
  tabs. Split siblings use `┌ / ├ / └` annotations rather than a duplicate group
  parent. The list hides for one PTY and snaps to a 46px icon-only form when
  collapsed. The toolbar shows the active title when the list is hidden or
  icon-only, so the same title is never repeated in two text rows.
- Files renders a lazy tree rooted at the current Project. Expanded directories
  refresh after file events and file creation targets the selected directory.
- A terminal that exits with code zero and no signal is explicitly closed and
  removed from its group. Parent splits collapse automatically, and removing the
  final terminal folds the dock. Abnormal exits remain visible and restartable.

This supersedes ADR 0169 only where that decision placed an additional fold
control inside the Terminal dock.

## Consequences

The primary workspace gains vertical space and exposes layout state in one
predictable location. Files retain their directory context while browsing.
The Terminal canvas stays wide and visually quiet while its instance hierarchy
remains directly selectable.
Normal `exit` and Ctrl+D behavior matches an IDE terminal, without discarding
diagnostics for crashed or signaled processes.
