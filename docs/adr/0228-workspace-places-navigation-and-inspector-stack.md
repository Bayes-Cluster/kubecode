---
type: ADR
id: "0228"
title: "Workspace places, secondary execution history, and one inspector stack"
status: proposed
date: 2026-10-20
supersedes: "0224 §1 (navigation composition: a tree of every Project's Sessions in the primary navigation), §2 where the Sessions surface is the main pane's default view, §3 (one on-demand detail area holding a single object, and a narrow screen hiding its list), and the Consequences' 'a Workspace with Sessions reopens on the Sessions surface'; extends 0224 §5 (route grammar)"
---

## Context

ADR 0224 made the Workspace the place a researcher lives in. It wrote that
place into the URL hash, but the place was one value, `ViewState | null`, in
which `null` meant the Sessions surface. The navigator listed the selected
Workspace's General, Kanban, Resources and Members above a tree of every
Project's Sessions. Several things followed from that:

- Choosing a Project showed the Sessions surface and that Project's latest
  Session.
- A Workspace that had Sessions reopened on them.
- Every primary view had a "Back to Sessions" button.
- Nothing was remembered per Workspace. Choosing General from the navigation
  dropped the message, the filter and the open Task.
- A Task, a member profile and evidence each had their own detail mechanism,
  and none could lead to another, so going from a Task to its evidence and back
  was impossible.
- On a phone the list behind a detail was removed with `display:none`, which
  lost its scroll position.
- Unsent drafts lived in component state and vanished whenever their view was
  left.

The Research Workspace redesign (#214, #216) asks for one Workspace hierarchy,
execution history as secondary access, and an inspector that returns the
researcher to exactly where they were.

## Decision

### 1. One navigation, with execution history secondary

The navigation lists the **Workspaces**, one row per registered Project with its
run status in words and its actions. Then come the selected Workspace's places in this order:
**General**, **Kanban**, **Resources**, **Needs you**, then **Members**. Below
them, under visible headings, are the Workspace's **Agents** (its members) and
its **Direct messages**. A member's name opens their profile in the inspector;
a private-message action opens the conversation.

One collapsed **History and execution** section holds:

- the Session search, labelled with its real scope;
- this Workspace's Sessions and Teams;
- legacy Threads;
- research questions.

It stays open while it holds what is on screen (a Session, a question, a
Thread) or the search has text. Files, Git, Plan and the terminal remain tools
opened from the title bar (0224 §4 stands). No primary view has a way "back to
Sessions". The Sessions surface opens only when the researcher chooses a
Session or creates one, follows a Session reference, a permission request or a
notification, or opens a link to it. Nothing falls back to it. Choosing the
destination already shown changes nothing.

### 2. A remembered place per Workspace

The researcher's place in a Workspace is a **location**: a *place* plus an
*inspector stack*, both holding ids and view names only. A place is one of:
General (with an optional message, Task filter and legacy Thread), Kanban,
Resources, Members, a private conversation, execution history (with its
Session), or a legacy question.

A pure reducer keeps, for every Workspace, its current view and the last
location of every view it visited. The active Project remains the shell's
selection, and the location is looked up by it, never copied.

- Choosing a view restores that view's own location in this Workspace.
- Choosing a Workspace restores that Workspace's location.
- A Workspace never visited, or one that is new, opens **General**, whether or
  not it has Sessions.
- A remembered Session that no longer belongs to the Workspace, or a private
  conversation with a removed member, falls back to General.
- A link in the address decides first. While it is being reached, the main pane
  shows a neutral "Opening Workspace…" state, never a Session.
- The app starts in the Workspace used last.

Locations are kept in local storage (`kubecode:workspace-location:v1`) as
formatted routes. They are validated by the strict route parser on read,
limited to 50 Workspaces and 12 views each, and forgotten when a Project is
unregistered.

### 3. One inspector stack

A Task, a member, evidence (a record as a Task cited it, at its pinned version)
and a resource (a live Project record) open in one **inspector** that belongs to
the view it was opened from. General, Kanban, Resources, Members and private
conversations host one; execution history and legacy questions do not.

- Opening something from the view replaces what is inspected. Opening something
  from inside the inspector pushes it on top (Task → evidence → participant),
  up to four deep.
- Opening an entry already in the stack returns to it.
- Back pops one entry, Close returns to the view, and Escape pops one entry.
- Entries hold ids only. The stack is the only record of which Task is open, so
  no Task state is duplicated.

When the view and the inspector fit side by side (a 480-pixel view beside a
400-pixel inspector, after any open Files and Git column), the inspector sits
beside the view with *Close*, plus *Back to <previous>* once something was
opened from inside it. Otherwise, as on a phone, it replaces the view and
offers only Back, one level at a time: *Back to <view>* on the first entry and
*Back to <previous>* above it, with no Close. When the layout narrows so that
the inspector comes to cover the view that had focus, focus moves to the
inspector's heading. This is ADR 0227's header rule applied to a stack:
Back appears where a detail replaced its list or another detail. Inspected
content renders the one `ViewHeader` of ADR 0227 with the Back and Close the
shell gives it, and never draws its own.

The view underneath and the lower entries stay mounted, made inert and hidden
in a way that keeps their scroll position and input (`visibility: hidden`,
never `display: none`). Focus returns to what opened each level.

Evidence reports to its stack which version it actually displayed, so a review
can bind acceptance to a version the researcher saw (ADR 0225 and 0226 rules
unchanged). Feature slices supply each kind's content through typed panels and
navigate through a shared context. They never add their own side panel.

### 4. Returning restores the researcher's place

- General reports where the researcher is reading, and leaving General records
  it. Returning lands on that message, or at the latest message if that is
  where they were.
- Lists that are left and re-entered restore their scroll positions.
- Unsent drafts and reply targets are kept per Workspace and destination:
  General, General scoped to a Task, each Thread, each private conversation. A
  filter change never moves a draft, and a private draft never shares a key
  with General.
- Drafts, scroll positions and focus are kept in memory for the life of the
  page and are deliberately not written to storage, so private text never
  reaches disk.
- Re-entering a view from the navigation leaves focus on the navigation on wide
  screens. When the navigation sheet closes on a phone, focus moves to the
  remembered message or composer.

### 5. Routes

The 0224 hash grammar is kept, and every link written under 0224 resolves to
the same place and is written back byte for byte:

- one inspected Task is still `?task=`;
- one profile on Members is still `?member=`;
- a Task over a legacy Thread is still `?task=…&thread=…`.

Deeper entries are repeated `inspect=` parameters (`task~<id>`,
`member~<id>`, `evidence~<kind>~<id>[~<revision>]`, `resource~<kind>~<id>`).
Parsing keeps the longest valid prefix. An entry whose id is not a route-safe
id, such as a file path, ends what is written, so routes and stored places
never carry paths. The query is formatted so that these separators stay
readable.

Inspector and view changes add history entries, so the browser's Back walks
back through them. Recording a reading position or correcting a stale place
replaces the entry instead.

## Consequences

Switching Workspaces or views, or opening and closing an inspector, never lands
in an unrelated Session and never loses the researcher's message, scroll
position, filter, draft or focus. General → Task → evidence → Back works the
same on desktop, on a phone, and with the browser's Back button. Every link
that worked under ADR 0224 still works.

The Sessions surface and the technical tools remain fully available, one step
further away. A Project used only for coding sessions opens in General until
its execution history is visited once, and reopens there afterwards. Unsent
drafts survive view and Workspace changes but not a reload, as before.

`ViewState` and every "Back to Sessions" are removed. The conversation (#217),
Task (#218), resource (#219) and attention (#220) slices own their content and
use the navigation, inspector and place-memory contracts rather than shell
state. The route token grammar, the inspector entry kinds, the stored location
format, the place-memory keys and the reading position change only through a
superseding ADR, because stored places and shared links depend on them.

Sections 4 (tools on request) and 6 (landing on an old message) of ADR 0224,
and its Kanban, Resources and Members views, remain in force. ADR 0227, still
proposed, takes the wording "a detail screen that replaced its list or another
detail" for its Back rule before it is accepted.
