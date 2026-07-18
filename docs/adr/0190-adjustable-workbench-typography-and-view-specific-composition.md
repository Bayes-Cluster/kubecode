# ADR 0190: Adjustable workbench typography and view-specific composition

## Status

Accepted

## Context

The Agent-first hierarchy introduced by ADR 0189 still used a narrow transcript,
fixed interface text sizing, and layout controls split across the title bar.
The Team board also inherited the Chat Composer even though the board is a
coordination view rather than a conversational surface.

Users need a denser or more readable workbench without changing editor or
terminal metrics, and each central view should expose only the controls that
belong to that view.

## Decision

- The Agent timeline and Composer share a 60-rem maximum content width.
- Appearance preferences include an integer UI font size from 12 through 20
  pixels, defaulting to 14 pixels. Existing browser-local settings without this
  field migrate to the default.
- UI font size applies to workbench chrome, Agent messages, and the Composer.
  CodeMirror and xterm continue to own their independent text metrics and font
  families.
- Session navigation, Terminal, and context-panel visibility controls live
  together at the right edge of the workbench title bar, in that order.
- The Team board does not mount the Agent timeline, permission prompts, plans,
  or Composer. Switching to the Team Session's Chat view mounts those
  conversation controls again.
- The Terminal's internal TTY navigator control remains local to the Terminal
  because it changes Terminal structure rather than global workbench layout.

This extends ADR 0189 and does not change Session, Team, terminal, or Agent
lifecycle semantics.

## Consequences

Agent responses and input now align on a wider reading column. Users can tune
interface readability without changing code editing or terminal geometry.
Global layout state is visible in one predictable location, while the Team board
stays focused on coordination rather than presenting a non-functional input.
