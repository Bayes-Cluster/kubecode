---
type: ADR
id: "0239"
title: "Chat-aligned conversation, a wide thread, and a quiet composer"
status: accepted
date: 2026-10-21
supersedes: "0233, the sentence that the researcher's own message is tinted rather than right-aligned; 0238 §3, the rule that General's and a DM's message list share one column as wide as the composer (`--ws-composer-width`)"
---

## Context

ADR 0238 put General's and a DM's messages and the dock in one centered column
as wide as the composer, about 790 pixels. On a desktop that squeezed long
research messages into the middle of a wide pane, while ADR 0233 kept the
researcher's own messages in the same left-aligned column, tinted. The
composer also carried a recipient row and explanatory lines (what mentions do,
who sees a DM), and several headers and lists repeated similar hints. The
researcher asked for a conversation that reads like a chat, wider messages,
and less explanatory copy (#229).

## Decision

### 1. A wide thread

General's and a DM's message list keeps its scroller across the pane and pads
its content to the middle three quarters (`--ws-thread-width: 75%`), at least
one gutter on each side. Messages are not capped at the reading width inside
that column. Under 768 pixels the thread takes the pane less its gutters.

### 2. A centered composer at most half the pane

The dock (running strip, outbox, Prompt Input card) is centered and
`min(100%, max(50%, 480px))` wide (`--ws-composer-max`), so it shrinks with the
pane and stays usable on mid-size panes. General and the DM use the same rule.
Under 768 pixels it takes the full width. Empty, the text box is two lines
tall and grows with its text up to a limit, then scrolls.

### 3. Chat alignment

The researcher's own messages sit on the right, as a tinted bubble at most 80%
of the thread wide, with no avatar or visible "You": only the time shows, and
the author stays in the accessible name. Members' messages sit on the left
with their avatar and name.

### 4. Quiet copy

The composer has no recipient row and no hint line; whom a message reached is
shown on the sent message. Only states the researcher must act on (members
loading or failed to load, nobody can receive) show in the card. General's and
the DM's header descriptions, the DM's "only {name} sees this" line, the
Kanban drafts hint, the proposal hint under a message and the Needs you
manager-decisions description are removed; the DM keeps its Private badge.

## Consequences

- Long messages use most of a desktop pane while keeping distance from the
  side panels.
- Removing a mention is done in the text; the composer no longer lists
  recipients as removable chips.
- Explanations removed from the UI live in the user guides.
