---
type: ADR
id: "0234"
title: "Needs you as a Workspace destination, one destination header, and a 360-pixel inspector"
status: proposed
date: 2026-10-21
supersedes: "0228 §2, the sentence listing what a place is one of (Needs you is now a place too); 0228 §1, where Needs you is a list inside the navigation (the navigation now only counts what waits); 0228 §3, the 400-pixel inspector in the side-by-side rule (now the 360-pixel inspector column)"
---

## Context

The Workspace shell rebuild (#231, parent #229) asks General, Kanban,
Resources, Needs you and Members to share one navigation and one header, and
the inspector to take the proportions of the #230 prototypes (ADR 0233:
`--ws-panel-inspector` is 360 pixels). Under ADR 0228, Needs you was a
disclosure inside the navigation: on a phone it lived in the navigation sheet,
it had no header, no address and no remembered place, and a long list pushed
the members and execution history out of reach. The inspector fitted beside a
view only from 400 pixels, which the 360-pixel column never uses.

## Decision

### 1. Needs you is a place

Needs you becomes a Workspace place, `{ view: 'needs-you' }`, with the route
`#/p/<project>/needs-you` and the view key `needs-you`. It is remembered like
Kanban or Resources (current view, LRU, local storage), restored by Back and
by Workspace switching, and reachable by a link under any base path. It hosts
no inspector: like execution history and a legacy question, its stack is
always empty and inspector parameters in its route are ignored, because each
entry opens where it is answered (ADR 0232), as before.

The navigation lists the five destinations in ADR 0228's order — General,
Kanban, Resources, Needs you, Members — each one button marked as current; Needs
you counts what waits (an emphasized count when anything does). The list
itself, every entry at once, is the Needs you view. The bell's "Show all in
Needs you" opens that view. What newly waits is still announced by the shell's
one status region.

### 2. One destination header

The five destinations share `DestinationHeader` (`app/DestinationHeader.tsx`):
the destination's glyph and name as a level-2 heading, a description, facts and
actions, over a hairline, with the same padding. A destination never offers
Back. Details keep `ViewHeader` at level 3.

### 3. The inspector column

Beside the view, the inspector is the 360-pixel `--ws-panel-inspector` column
behind a hairline; it is placed beside the view when the row holds a 480-pixel
view and a 360-pixel inspector after any open Files and Git column, otherwise
over it, with ADR 0228 §3's Back and Close rules unchanged.

Everything else in ADR 0228 stands: the location reducer, the inspector stack,
place memory, execution history as secondary access, and the title-bar tools.

## Consequences

- A link or remembered place may name `needs-you`; older builds read it as a
  damaged route and open General.
- On a phone, Needs you is a full view instead of a section of the navigation
  sheet; the sheet closes when it is chosen, like every destination.
- Rows narrower than 880 but at least 840 pixels now show the inspector
  beside the view.
