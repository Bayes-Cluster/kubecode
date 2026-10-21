---
type: ADR
id: "0240"
title: "One dock width, a two-line running item, and a reading measure on wide panes"
status: accepted
date: 2026-10-21
supersedes: "0239 §2, the dock width `min(100%, max(50%, 480px))` and the two-line empty text box"
---

## Context

On a 4K or other very wide screen the dock followed ADR 0239 §2 and took half
of the pane, but the Prompt Input card kept its 792-pixel cap and sat at the
dock's left edge, so the running strip and the card no longer lined up. Half
of a 3840-pixel pane is also far wider than a composer needs, member messages
ran to very long lines, the last message could end under the dock, and each
running item repeated the member's name in its status ("Analyst is working on
…") (#229).

## Decision

### 1. One dock width

The dock (running strip, its running list, outbox and Prompt Input card) is
`min(100%, clamp(480px, 50%, 960px))` of the pane, centered; the card fills
the dock and the running list opens as wide as the strip. Under 768 pixels the
dock takes the pane less its gutters, as before. The message list ends with
room above the dock, so the last message is never under it.

### 2. A two-line running item

The single running row and each row of the running list are one component.
Its first line is the member (avatar, name, muted handle), then a muted
"N queued" count when messages wait and a compact ghost Stop that reads
"Stop task" for a Task (pause, then end its turns, as ADR 0238 says) or "Stop
reply"; the accessible name still names the Task or the member. Its second line
is the Task title, or "Replying", on one line with the full title on hover; a
wait reads "Waiting for your permission" or "Waiting for the Team leader".
The name is never repeated in the status.

### 3. A reading measure and a compact card

Inside the 75% thread a member's message body is at most about 90 characters
wide and the researcher's bubble at most 80% of the thread and about 70
characters. Empty, the card's text box is one line over its tool row and grows
with its text as before.

## Consequences

- The composer stays usable and centered on 4K panes instead of growing to
  1900 pixels.
- Explanatory hints in the Task inspector are removed with the same intent as
  ADR 0239 §4; the Task chip is not repeated under messages while General is
  filtered to that Task.
