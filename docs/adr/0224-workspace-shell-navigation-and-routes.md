---
type: ADR
id: "0224"
title: "Workspace shell: General, Kanban, Resources, and members, with stable hash routes"
status: proposed
date: 2026-10-19
---

## Context

The workbench was organized around Sessions: a project tree of Sessions and
Teams, a permanent Files/Git column, and research, the conversation, and the
board as three more entries beside them. The Research Workspace blueprint
(#199) makes the **Workspace** the thing a researcher lives in — General is
home, Tasks are tracked on one board, agents are members — and Sessions and
Teams become execution detail. The shell also had no addressable state: a reload
forgot the view, Back left the app, and a link to a message or Task could not be
shared.

## Decision

### 1. One navigation

Under the selected Project, the navigator leads with **General**, **Kanban**
(the one board), **Resources**, and **Members**, then a **Needs you** entry,
then the roster as `@handle`s with a private-message action. **Needs you**
gathers what waits for the researcher: Tasks in *Review* or with a request for
input (from `GET …/tasks/board`, refreshed on `task_updated`/`research_updated`/
`work_updated` events and after a reconnect) and Sessions waiting for a
permission answer. Sessions, Teams, legacy Threads, and research questions
stay reachable — Sessions in their tree below, Threads and questions under a
collapsed **History and execution** disclosure — so history is preserved and its
role is plain.

### 2. Views, one at a time

The main pane shows exactly one view: the Sessions surface, General,
Kanban, Resources, Members, a private conversation (ADR 0223), or a legacy
research workspace. They are one value (`ViewState`), so two views can never
claim the pane, and choosing a Project hides the previous Project's view.

- **Resources** reuses the Composer's project-work reader (`ComposerProjectWorkPicker`)
  in a browsing mode: choosing a row previews it read-only, and the preview
  offers *Open* only for records that have somewhere to go (a question, Session,
  Thread, the conversation, work). What can be found here can be cited in a
  message.
- **Members** is the existing roster and defaults; a name opens the member's
  profile in the detail area.

### 3. One on-demand detail area

Tasks, agent profiles, and evidence open in a **detail pane** beside the list
that opened them — a Task from a General message's chip or from the board, a
profile from the roster. A Task's detail is its research workspace (brief,
discussion, work, findings, evidence viewers). Closing it returns to the list
with the originating message focused again. On a narrow screen the list and its
detail are separate screens (the list is hidden while the detail is open), with
the detail's own *Close details* as the way back.

### 4. Files, Git, and the terminal are tools

The Files/Git column belongs to the Sessions surface. Beside the research views
it is closed and opens only when the researcher asks (the existing toggle), and
is gone again when the view is left. The terminal keeps its own toggle.

### 5. Routes live in the URL hash

The place is a value — project, view, and the ids that narrow it (a Session, a
message, a Task, a filter, a Thread, a member) — written as
`#/p/<project>/general/m/<message>?task=<id>`. A hash never changes the path the
server serves, so it is correct under any configured base path. The format is
parsed strictly: an unknown view, a missing or unsafe id, or a damaged link is
`null` and opens the default view rather than a guess. `useWorkspaceRouteSync`
applies a valid hash on first load (after the Projects are known), pushes a
history entry when the place changes (Back/Forward and a reload therefore work),
applies a pasted or edited hash, and does not overwrite a requested place with
the states it passes through while a Project loads (with a timeout after which
it shows where it is). A route contains ids and view names only — no paths,
prompts, or content.

### 6. Landing on an old message

A route can name a message. The conversation reads it by id
(`GET …/channels/{c}/messages/{id}`, scoped to the Project and channel), loads a
page around it, then catches up to the newest message so the list stays
contiguous, and focuses the message.

## Consequences

The first screen of a Workspace is the same Sessions surface as before; the
Workspace views are one click away and addressable. `WorkbenchShell` remains
the owner of state; the route is derived from it and applied to it rather than
replacing it. Legacy smoke flows reach questions and Threads through the History
disclosure. Task *interaction* (the proposal, instruction, review, and board
cards) is #205; this ADR provides the places they live in.
