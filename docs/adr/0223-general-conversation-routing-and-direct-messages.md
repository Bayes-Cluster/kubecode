---
type: ADR
id: "0223"
title: "One General conversation, routed to members, with private direct messages"
status: accepted
date: 2026-10-19
supersedes: "0216 (plain messages are only recorded) and 0217 (only ask and request intents are routed), for the Workspace conversation"
---

## Context

The Workspace conversation (ADR 0216) recorded messages and ran nothing: a plain
message reached no Session, only an explicit *ask* or *request* intent was
routed (ADR 0217), and an agent could answer only inside a Thread it had
standing in. The Research Workspace blueprint (#199) makes General the one
public place where the researcher and the members work together: a remark
reaches the project manager (ADR 0220) without a form, a `@mention` reaches the
member it names, members hand work to each other where everyone can see it, and
the researcher can talk to one member privately without that conversation
leaking into anything shared.

## Decision

### 1. The server reads the conversation once and routes it

A top-level General message is marked *pending* when it is written if it is a
researcher's plain remark, or an agent message that names someone. The
orchestrator reads each pending message exactly once (`route_conversation`),
writes durable routes (`message_routes`, one per source and target, ADR 0217),
and only then marks it read, so a crash in between repeats the pass and finds
the routes already there. Delivery keeps its existing guarantees: lease,
backoff, per-recipient de-duplication, resolution of the recipient at delivery
time.

- A researcher's message that names members reaches those members' **public**
  Sessions and nobody else.
- A researcher's message that names no member reaches the **General Agent**, so
  brainstorming, proposals, and "add the task we discussed" all work without
  `@General`. The manager is not copied on a message addressed to a specialist.
- A reply in a legacy Thread is not conversation chatter and is not routed.
- Routing never authorizes anything. The prompt tells the receiver so; Task
  admission still requires the researcher's own message and the checks of
  ADR 0221.

### 2. Members hand work to each other in General, visibly

Members speak in General with `general_post` (the `kubecode-work` tool): a
top-level message attributed to the member, optionally naming up to four
members by `@handle`, citing a Task, and replying to an earlier message. It is
allowed only from a live member's **public** Session; a direct-message Session
is private and cannot publish. A message that names members is routed to them
as an *agent hand-off*: the prompt fences the text as written by an agent and
says it is a report, request, or suggestion — never the researcher's
authorization — so a specialist's words cannot admit or widen a Task.

Chains are bounded two ways. Every message carries a hand-off depth: the
researcher's message is 0; a member's hand-off that answers a message routed to
it (`reply_to`) is one deeper than that message, and otherwise one deeper than
the newest message routed to it within the day (1 if none). The store refuses a
depth above `MAX_HANDOFF_HOPS` (4) and the tool says to ask the researcher.
Because depth is derived from routes the speaker can influence, a member is also
held to 12 hand-offs per hour, so a loop is bounded however it is shaped. A message that
cannot be delivered (a hand-off naming a direct message or no live member, or a
researcher's remark when no project manager is available or the member it names
needs setup) leaves a system note in General rather than failing silently, and
a message addressed to an unavailable member is never handed to the manager. A non-member
Session never speaks as a hand-off.

### 3. Tasks, citations, and filtering are views of one history

A message records the Task it is about (the first research question it
references), and may cite an earlier message of the same channel (`reply_to`).
`GET …/messages?task_id=` lists the same records, with the same ids and
sequence numbers, that the unfiltered conversation shows; no second history is
written. The browser jumps from a citation to the original and from a message
to its Task. Task execution does not create another public chat.

### 4. A direct message is private to the researcher and one member

A direct message (DM) is the researcher's conversation with one member, held in
that member's DM Session (ADR 0220). The researcher opens it
(`POST …/members/{id}/dm`), reads its turns, and sends to it
(`…/dm/messages`) through the same delivery as every member message, so the
Session is configured and briefed first. Nothing is posted to General.

Audience isolation is enforced where records are read, not by convention:

- Project context hides every DM Session (and every Session that ever served as
  one) from search, resolve, and read — for agents and the researcher's pickers
  alike. The lookup fails closed if the roster cannot be read.
- A message cannot mention or cite a DM Session (HTTP), `general_post` is
  refused for it, and the orchestrator refuses to carry a mention of one. There
  is therefore no agent-to-agent DM, and another member cannot retrieve DM
  content, including when the same agent serves both General and its DM: the
  two are different Sessions and only the public one can speak in General.
- Members never learn a DM Session's id from the roster tools. The Task
  commands (`task_propose`, `task_revise`, …), which post into General, and
  `general_post` are refused for a DM Session, and `work_post` refuses to cite
  one; an `ask` naming one is skipped by the orchestrator.

### 5. Sharing out of a DM is previewed, chosen, and confirmed

The researcher picks up to six turns, may add a note and a Task, and the server
composes the exact text. The member's words are quoted (`> `) so that, inside a
researcher's message, they can never read as the researcher's instruction to the
project manager (ADR 0221 ignores quoted lines); text too long for one message
or a Task that does not exist is refused at the preview. Confirming posts that text to General *as the
researcher's own message* (it then reaches the manager like any remark) and
requires the digest of the previewed text: if the DM changed since the preview,
the share is refused (`dm_share_stale`) and must be previewed again. The same
confirmation twice is one message. Private history is never copied
automatically.

### 6. Legacy

Threads remain readable and writable through their existing routes and
`work_post`; they are no longer how members speak in General. A reply in a
Thread is recorded but not routed as chatter.

## Consequences

A plain message now causes a provider run for the manager, so a Workspace with
no available provider shows the failure through the member's setup state and a
system note rather than silence. Server-authored notes are English (ADR 0221's
known gap). Routing is by Session, so a member whose Session is replaced while
a route is pending has that route fail with a note instead of following the
member. The DM surface reuses the shared Composer (ADR 0222) and the member's
own Session; richer activity inside a DM is the Session view's job.
