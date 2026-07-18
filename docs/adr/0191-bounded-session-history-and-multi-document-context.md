# ADR 0191: Bounded Session history and multi-document context

## Status

Accepted

## Context

Long-running Agent Sessions can contain hundreds of turns and thousands of
normalized events. Loading and mounting the entire transcript on every Session
switch makes latency and memory usage grow with Session age. The Explorer also
treated CodeMirror as a single replaceable document, so opening another file or
switching Projects could discard an in-progress draft.

The workbench needs bounded browser work without weakening durable Session
history or Project filesystem ownership.

## Decision

- The Session history API returns cursor pages of at most 100 runs. The default
  page contains the newest 50 runs in chronological display order and includes a
  cursor for the next older page.
- Each history page contains the normalized run events and the Session events
  associated with those runs. The browser merges older pages by stable run and
  event identity.
- Agent timelines with more than 100 loaded runs use `react-virtuoso` for
  variable-height rendering and prepend anchoring. Smaller timelines retain the
  direct render path.
- The Composer draft is browser-session state keyed by Kubecode Session ID. A
  running Agent does not disable editing; the draft remains available until it
  can be submitted or explicitly cleared.
- The context workbench owns a set of open CodeMirror documents keyed by Project
  ID and relative path. Each document retains its own saved content and draft.
  A dirty close requires confirmation. Optional browser-local Auto Save writes
  after one second without input; manual save remains the default.
- File search traverses Project-relative directory listings through
  `WorkspaceService`, bounds traversal and result count, and excludes hidden,
  Git-ignored, and known generated directories by default. The user may reveal
  them explicitly. The server annotates entries but never exposes a new
  arbitrary-path API.
- Below 980 pixels, navigator and context panels become mutually exclusive
  overlays. They close through the backdrop or Escape; desktop resizing and
  Project-scoped geometry remain unchanged.

## Consequences

Session opening and browser memory are bounded by the loaded window rather than
total history size. Users can request older turns without changing durable
ordering. Variable-height Agent content keeps scroll anchoring without assuming
fixed message heights.

Multiple Project files can remain open without silently losing edits. Auto Save
is explicit and local to the browser preference. Search may perform several
bounded directory-list API requests, but never bypasses Project registration or
`WorkspaceService` validation.

`react-virtuoso` becomes a frontend runtime dependency. Its use is isolated to
the long Agent timeline and can be replaced without changing the history API.
