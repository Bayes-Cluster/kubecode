# ADR 0189: Agent-first workbench visual hierarchy

## Status

Accepted

## Context

Kubecode had accumulated separate Project and Session navigation surfaces,
repeated headers around the Agent workspace, and equally prominent controls for
primary and secondary actions. This reduced the space available to the Agent
timeline and made Project switching feel separate from Session navigation.
Changes, Files, and Agent plans also competed for independent tabs or vertical
space.

Kubecode needs an IDE-like information hierarchy without turning the Agent
workspace back into an editor-first product. The active Session and its Composer
remain the primary surface; navigation, source context, and terminals support
that work.

## Decision

- Projects and their Solo or Team Sessions share one hierarchical navigator.
  Project rows expose absolute paths as titles, activity status, Workspace
  control, creation, and removal without a separate Project rail.
- One 44-pixel workbench title bar owns the active Session identity, global
  Session search, attention indicator, and layout controls. `Cmd/Ctrl+K` focuses
  the search field.
- The Agent timeline and Composer share one bounded content width. Tool calls
  use compact neutral rows, user messages use restrained bubbles, and the
  Composer remains the stable bottom anchor.
- Agent plans show a compact progress summary above the Composer. Their complete
  checklist lives in the right-hand Explorer beside independently collapsible
  Changes and Files sections.
- CodeMirror and diff views open as contextual tabs inside Explorer instead of
  replacing the active Agent Session.
- Phosphor icons use a shared 16-pixel regular-weight baseline. Semantic file
  icons, small status dots, theme tokens, and theme preview swatches communicate
  state without decorative color or product-specific icon forks.
- Navigator visibility is global. Context and Terminal geometry remain
  Project-scoped, and existing browser layout preferences migrate forward.

This supersedes ADR 0165 where it separates Project and Session navigation, and
extends ADR 0170 without changing terminal lifecycle behavior.

## Consequences

The Agent Session gains the strongest visual priority while Project, Git, files,
plans, and terminals remain one interaction away. Dense navigation supports
many Projects and Sessions without adding another rail. The visual system stays
theme-driven and avoids hard-coded colors outside preview swatches.

The title bar and Explorer now coordinate state across components. Session
summaries therefore include durable Team title and status fields so navigation
does not wait for a second Team snapshot request after restart.
