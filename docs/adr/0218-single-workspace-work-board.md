---
type: ADR
id: "0218"
title: "One Workspace work board over canonical work records"
status: proposed
date: 2026-10-19
supersedes: "0177 and 0186 where they make the Team board the place research tasks are shown and commanded"
---

## Context

ADR 0215 made work a Workspace-owned record, ADR 0216 a shared conversation
that points at it, and ADR 0217 the orchestration that creates and runs it. The
browser still showed tasks on a Team-owned five-column board (ADR 0177): one
board per Team, a status vocabulary that mixes where work is with why it is
stuck, and no view of work that has no Team, no Thread, or a different
research question. Several boards would also mean several answers to "what is
the state of this task".

## Decision

### 1. One logical board, many filters

There is exactly one board per Workspace (Project). Research question, round,
Thread, Team, Agent (executing Session), condition, and source are **filters**
over the same items. A filter narrows the set; it never creates another board
or another card, so opening a task from a Thread, a research question, a Team,
or the board shows the same card in the same state.

### 2. Server-composed projection

`GET /projects/{id}/work/board` returns the canonical records, composed by the
server: the work item's facets, its executor and Agent, research and round
names, originating Thread, attempts and experiment counts, structured
blockers, whether the researcher can command it here, and the newest delivery
state of a dispatch or result. Counts per stage and per condition come from
the same filter. At most 200 cards are returned and a truncated board says so;
closed work is a separate lane. `GET /projects/{id}/work/{id}` is the
inspector's record: attempts, assignments, evidence, reviews, deliveries, and
experiments. Dependency readiness, dispatch, and limits remain server
decisions; the browser has no automation engine.

Stages are the work store's — Planned, Ready, Executing, Analyzing, Review,
Done — and are not derived from a Team status. Waits, blockers, pauses, and
human-input needs are **conditions**, shown beside the stage and summarized
separately. Retries are attempts under one card. A failed attempt, a valid
negative result, blocked work, and accepted delivery are distinct marks.
Canceled, abandoned, and superseded work keeps its reason in its own lane.

### 3. Commands are the work store's

The researcher's commands — add a task, assign, start an attempt, pause,
resume, prioritize, review, and close — go through the same revision-checked
store commands as the agents', carrying the **state revision** the card was
shown at: a card that moved on is refused with the current revision and the
browser reloads it. Limits bind the researcher too. Dragging a card only
*expresses* one of these: Ready to Executing is `start`, Review to Done opens
the accept form, Review to Executing the request-changes form, and a drop on
the closed lane the close form. Every other drop is refused with an
explanation, and no drop completes work.

### 4. Legacy Team work stays operable through its Team

Mirrored Team tasks appear on the board with their Team attribution and are
marked as Team tasks. They are not commanded from here (ADR 0215 §5): opening
one from the Team view opens the Team's own task dialog, and from the board it
offers a way to open the Team. The Team view's task tab is this board under a
Team scope; the separate Team column board is gone.

## Consequences

Entry points are contextual (a Thread's "view work from this thread", a
question's "open on the work board", the Team view) and the board converges on
`work_updated` and `orchestration_updated` events and on a return to a live
stream. A task added by the researcher without a round is a candidate: it is
visible and plannable, and cannot run until it belongs to an approved round.

Not covered here: the experiment and analysis views inside the inspector beyond
counts, state, and the pending-analysis mark (ADR for #190); editing a task's
plan text from the board; round limits have an API (ADR 0217) but no control
on the board yet; and the board is not paged beyond its 200-card window.
