# ADR 0165: Session-first browser workbench and local Git Review

## Status

Accepted

## Context

ADR-0162 placed CodeMirror in the center and AI in a right panel. The target
product is instead an Agent Session workspace modeled on OpenCode Web, where
files, diffs, Git, and terminals support the Session rather than displace it.

## Decision

- The browser uses a Project rail, Project-scoped Session sidebar, primary Agent
  Session, tabbed right Context Workbench, and bottom Terminal spanning both
  main columns.
- Review is the default context tab. Files, editable CodeMirror documents, and
  diffs open as adjacent tabs without replacing the Session.
- Local Git status, diff, init, stage, unstage, discard, and commit are provided
  by a Project-scoped `GitService` using argument-based system Git execution.
- Remote sync, branches, and conflict resolution are deferred.
- Panel dimensions are freely draggable within small usability bounds; the
  OpenCode layout supplies structure, while existing theme tokens, shadcn
  controls, Agent icons, xterm, and CodeMirror remain implementation primitives.

## Consequences

The Agent timeline/composer is now the stable center of the product. Editor and
Git features can grow independently in the context pane, and Terminal lifecycle
remains separate from structured ACP Sessions.
