---
type: ADR
id: "0229"
title: "Member identity in the conversation, member-following routes, and one public reply"
status: proposed
date: 2026-10-20
supersedes: "0223 Consequences, the sentence 'Routing is by Session, so a member whose Session is replaced while a route is pending has that route fail with a note instead of following the member.' Extends 0220 §1 and 0223 §1-§3 and §6."
---

## Context

ADR 0220 made a member a durable identity whose Session can be replaced, and
`member_sessions` records every Session a member has had. The browser still
named message authors through the Sessions list, which leaves member Sessions
out, so every member appeared as "Agent" and every mention as a fragment of a
Session id. Routes created from General target a Session fixed at routing time.
ADR 0223 states that such a route fails with a note when the Session is
replaced. In fact the replaced Session stays visible, so a pending route was
delivered to a Session that no longer has any authority, and the work was
silently lost.

A researcher message that named the project manager was framed as a mere
mention, which loses the admission path of ADR 0221 ("@general yes, add it").
General offered three message types and two ways to reply (a citation and a
Thread), added the Task filter as a hidden reference, showed object ids, and
lost drafts when the view changed.

## Decision

### 1. Messages name members through every Session a member has had

The HTTP projection of a General message adds `author_member_id` and
`mention_member_ids`, resolved through every **public** Session the member has
had, current or ended, and never through a direct-message Session
(`MemberStore::public_authors`). It is computed when the message is read and is
never stored, so message records are not rewritten. It is served on every
message read and write of the conversation API (`GET`/`POST` channel messages,
one message by id) and on the direct-message share response. The projection
grants nothing: authority still comes from the current binding (ADR 0220 §4).
If the lookup fails, the author is shown as unknown, never as another member.

The browser reads the roster including removed members and presents every
party in a conversation with ADR 0227's identity (name, @handle, role in words)
in messages, recipients, mention suggestions, the roster, profiles and DMs. A
removed member keeps their name in history. Membership states are shown only
when they need the researcher (setup, removed). An active member carries no
status badge, because membership is not activity.

### 2. Mentions name members; routes follow the member

A message from the browser names recipients by member id (`{member_id}`). The
server resolves each one to the member's current public Session when the
message is written, and refuses (400 `mention_unavailable` with a `reason` of
`removed`, `needs_setup` or `not_found`) a member who is removed, cannot
receive messages, or is not in this Project. The stored mention keeps its
Session form. A retry with the same client message id reuses the Session the
stored message named that member by, so a retry after a Session replacement
replays instead of conflicting. Legacy Session-id mentions are still accepted.

A conversation route (discussion, mention, agent hand-off, Task review) is
resolved again when it is delivered:
- If its target Session is a member's ended public binding, it goes to that
  member's current public Session.
- If the member was removed, it fails with a note.
- If the member needs setup, it is retried and then fails with a note.

Hand-off depth follows the Session the route was actually delivered to. Routes
recorded before this decision are covered without migration. Work dispatch,
work hand-offs and legacy asks keep their own targets.

### 3. The project manager is always addressed as the manager

When a researcher's message reaches the General member, whether by default or
because it is named, the manager is prompted with the manager's framing,
including the admission instructions of ADR 0221. Specialists named in the same
message receive the mention framing. Routing still authorizes nothing.

### 4. One public reply

Reply cites an earlier General message (`reply_to`) and writes into General.
Replying to a specialist who can receive messages puts that member's `@handle`
into the draft. Replying to the manager adds nothing, because a message that
names no one already reaches the manager. The resulting recipients are shown
before sending and can be removed. The cited message's Task becomes the draft's
visible, removable Task.

The recipient's prompt names the cited message and its author and quotes the
message as fenced data. A reply never creates a Thread or a private
conversation, and never admits, starts or widens a Task: admission still
requires the researcher's own words, a shown proposal and the manager (ADR
0221). `general_recent` reports `reply_to` and the recipients (`to`, the named
members' handles through public Sessions only).

### 5. The General composer has no message types; Threads are history

Every message the browser writes to General is a plain message. Its recipients
are the members it @mentions, ignoring mentions in quoted lines and code, or the
project manager when it mentions none. A draft that names a member who cannot
receive messages is blocked with the reason, so it never falls through to the
manager.

The Task a draft is about is a visible chip, sent as the message's first
research reference. Other references are named chips.

The browser no longer starts Threads or posts into them. Existing Threads open
read-only and continue in General by citation. The HTTP API still accepts the
`ask`/`request` intents (ADR 0216 §3, 0217) and the Thread routes, for pages
opened before the upgrade and for round execution history.

### 6. Drafts belong to their destination

A General draft (text, reply, Task, references and its last send attempt) is
held in memory per Workspace and destination under the place keys of ADR 0228.
General, General scoped to a Task, and each direct message have their own key.
A failed send restores the whole draft, and retrying it reuses the client
message id. Private text reaches General only through the DM share flow (ADR
0223 §5), whose preview now shows the exact text with its recipient and Task.

### 7. Rich text, activity and delivery

Message bodies use the existing safe Markdown renderer without raw HTML; images
are shown as their alternative text, so a message cannot cause a remote fetch.
Routine system notes collapse into an activity summary. A note saying a message
could not be delivered is shown on that message.

Delivery states come from a replaceable source. The browser shows a failure
only when a note establishes it, and never claims a delivery it has not been
told about.

## Consequences

- General and its specialists stay distinguishable after Sessions are replaced
  or members removed, and a route pending across a replacement reaches the
  member's new Session.
- A reply to a specialist reaches that specialist instead of the manager unless
  the researcher removes the mention; the To row shows this before sending.
- Naming the manager no longer weakens admission.
- New Threads cannot be started from the browser.
- Unsent drafts survive navigation and failed sends but not a reload (ADR 0228).
- Each message read costs one indexed roster query. Identity degrades to
  "unknown" on a failed lookup, which is deliberately less strict than the
  fail-closed checks used for authority.
- Server-authored notes and prompts stay English (ADR 0221's known gap).
- Reference titles beyond Tasks, Threads and Sessions, and per-route delivery
  facts, are left to the resources and attention slices.
