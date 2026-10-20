---
type: ADR
id: "0232"
title: "Pending decisions, message delivery state, and scoped execution controls are server projections"
status: proposed
date: 2026-10-20
supersedes: "0224 §1, the sentence defining what Needs you gathers (Tasks in Review or with a request for input, and Sessions waiting for a permission answer), as carried by 0228's adapter; 0228 §1 where a permission request opens the Sessions surface, for Workspace members' Sessions; 0217 §1 where a failed route is final, for routes the researcher originated (discussion, mention, ask, request, task_review, decision); 0223 §1-2 where a message that reaches nobody is recorded only as a system note; 0229 §6, the sentences on a failed send (it restores the whole draft, and its failure and Try again are kept with the draft): a send the server has not acknowledged is now its own outbox row"
---

## Context

Needs you was assembled in the browser from three sources and counted one
decision twice: a Task in review, a Task needing input because of a question,
and the Session waiting on a permission were separate rows. It listed every
unadmitted draft, including drafts nobody proposed. Workspace members'
permission requests were invisible, because member Sessions are left out of
Session lists, so the researcher could not answer them in the Workspace.

A message's fate reached the researcher only as one system note per failure.
A failed route could not be retried, and a retry would have reused the failure
note's key: the channel store refuses a key reused with other words, and that
error aborted the whole delivery pass. A denial was only note text. A send that
failed after more text was typed merged the two drafts, and a direct message
queued behind a busy member vanished from view. Stop and pause did not say what
they affect.

## Decision

### 1. Pending decisions are a server read model

`GET /projects/{p}/attention` composes, on read and without a new table, the
decisions only the researcher can make:

- permission and input requests of the Project's runs addressed to the
  researcher, from the runtime's in-memory pending maps (a Team leader's
  request counts once it is escalated; escalation now updates the waiting
  entry itself, not only the announced copy);
- open questions on work inside a Task;
- open review requests;
- suggested changes of direction on a Task not yet agreed to or declined;
- every admitted Task's brief revised past the revision the researcher
  approved (not Done, not archived), whether or not General showed the
  revision;
- proposals the General Agent showed in General that are not on the board yet;
- members that need setup.

Each item is keyed by its decision identity (`permission:<request>`,
`input:<request>`, `question:<request>`, `review:<request>`,
`suggestion:<entry>`, `brief:<task>:<revision>`, `proposal:<task>:<revision>`,
`setup:<member>`) and appears once, whichever records refer to it. The Task
panel lists its pending decisions under the same keys, from the same rules.
Only a request the server times out carries a deadline: an input request is
declined after the pending-request timeout, while a permission request waits
until it is answered or its turn stops and reports none. An input request in a
member's direct message is named in project-wide lists (Needs you, the bell)
only by who asks; what it asks is shown only in the direct message's prompt,
because a direct message is private to the researcher and one member. Task stages and conditions, a run's
waiting status, unread messages and drafts that were never proposed are not
items. Items carry ids, the Task and member they concern, and short titles for
the researcher's own UI; they never carry tool input or file content and never
enter events or analytics. Each snapshot carries the workspace event cursor
read before its sources, and a source that cannot be read is reported as
incomplete, never as empty. The snapshot also lists the Sessions working now
(with what they work on, queued prompts and what they wait for), each member
Session's latest failed turn (status only), and the count of failed deliveries
the researcher can retry, in General and per Task. Resolution stays on the
existing endpoints, which commit before replying. `GET /attention/summary`
gives counts per Workspace.

### 2. Each item opens the context that holds the decision

The Task inspector for questions and reviews, its Results for a suggestion,
and its Overview for a revised brief General never showed; the message in
General for a proposal or a revised brief General showed (admission and
approval stay words-only, ADR 0221); for a member's permission
or input request, the prompt above General's composer (public Session) or above
the member's direct-message composer; the Session itself for other Sessions;
the member profile for setup. The browser removes an item only when a newer
snapshot omits it.

In the browser one attention store per Workspace holds the newest snapshot,
refetched (debounced) on the events that can change it and after a reconnect;
an answer older than the one shown, by request or by cursor, is dropped, and a
failed read keeps the last snapshot and says the list may be incomplete. Needs
you, the title bar's bell, the Task panel, the Working-now strip, notifications
and the Session prompt all read it. Answering goes through the store: the item
stays, marked as being updated, until a snapshot read after the answer omits
it (ten seconds at most), so every surface clears together; a request that is
gone (404) says it is no longer waiting. Each entry carries a focus key
(`permission:`, `input:`, `question:`, `review:`, `suggestion:`, `brief:`,
`message:`, `member-setup:`) that the destination focuses on arrival; a Task
opens on the section that holds the decision. What newly waits, and what the
researcher resolved, is announced in the shell's always-mounted status region,
so it is heard while Needs you is folded away or the navigation sheet is
closed. A prompt answered here stays busy until the snapshot drops it, so
neither a button nor a 1–9 key answers it twice. The Task panel never draws a second prompt: it
says who waits for the researcher's permission, with Show. The bell counts this
Workspace's decisions and the others' from the summary, and a notification
opens the waiting item of its Session when there is one.

### 3. Delivery state is a fact of the message

A researcher's message reports only proven states: saved, recorded (never
routed), sending (also retrying or busy), delivered — queued, started or
withdrawn, from the recipient Session's admission under
`route:<route>:<recipient>` — partial, failed, or denied. A denial is stored on
the message (`routing = 'denied'` with a code: `manager_unavailable`,
`member_unavailable`, `dm_private`), and a message that reached some of the
members it named records the code with `routing = 'done'`; a refused legacy
request records `request_refused`. "Delivered" keeps ADR 0217's meaning: the
Session has it. Routing notes are still written and still read by agents; the
browser folds a note into its message once that message's delivery is loaded,
and keeps the note's text under the message's Details. "Delivered" is said
only under the researcher's latest message, with what it means; Retry and Try
again are each at most once in flight, and a recipient whose Session is gone
offers the text back to the composer instead. `GET /projects/{p}/deliveries` reads
states by message, message pages carry them, and `orchestration_updated`
carries the message id.

### 4. The researcher may re-arm what they originated

A failed route of kind discussion, mention, ask, request, task_review or
decision may be re-queued under the same route identity with one conditional
write that also holds the limit, at most three times
(`POST /projects/{p}/routes/{id}/retry`). A conversation route whose Session is
gone is not retried (`route_target_gone`). A route to a member that needs setup
is refused without using a retry (`route_needs_setup`) and may be retried once
setup is fixed; a recipient that could not be looked up is worth trying again
(`route_unavailable`). A review verdict is retried only while it is the Task's
newest step and the Task is not archived; an older one is listed as superseded
and never delivered late (`route_superseded`). A message denied because the
project manager or a member was not available may be read again after setup is
fixed, at most three times (`POST …/messages/{m}/reroute`); a denial a reroute
cannot fix (a private direct message, a refused request) is not reroutable. The runtime's admission de-duplication on the
delivery key, and the one-route-per-source-and-target rule, make every repeat
the same turn. Failure and denial note keys include the retry or reroute count,
and a note already written under its key never aborts a delivery pass.
Dispatch, result, handoff, experiment and agent hand-off routes stay final when
they fail.

### 5. Sending is never blocked and never loses text

A direct message's send reports whether the member started on it or it is
queued, and `GET …/dm/pending` lists queued direct messages so they stay
visible, including after a reload. In the browser every send, in General and
in a direct message, is its own outbox row until the server has it: the
composer clears at once and is never filled again by that send, so nothing
typed meanwhile is merged into it; a failed send stays as its row ("Not sent:
why") with Send again under the same client message id, Edit (back into an
empty composer, as a new message from then on) and Discard. A lost
acknowledgement or a reconnect therefore never posts twice. Outbox rows live in
place memory for the life of the page, never on disk. Sending is never blocked
by running agents or by another send on its way.

### 6. Controls name their effect

Stop cancels one named run now; the member's assigned work and its attempt stay
open (a test pins this). Pause is the round execution policy of a named Task,
exposed on the Task detail as `execution` and changed through the existing
round policy endpoint: it stops new work being handed out and lets running work
continue. The experiment envelope's control pauses experiment launches in a
named round. There is no Workspace-wide pause (ADR 0227). The Task detail also
lists `delivery_issues`: decisions on it that did not reach their recipient.

In the browser the Working-now strip (above General's composer, above a DM's
composer, and in the Task panel without prompts) lists each member turn with
what it works on and what is queued (a turn waiting with nothing the
researcher can answer waits for its Team leader, and says so), and a Stop named
for the turn it ends ("Stop Analyst's current turn", "Stop Analyst's reply")
that stays busy until the run leaves the snapshot. On a narrow screen it sums
itself up in one line and its body is capped and scrolls, so prompts never push
the composer off screen. The composer offers the same Stop beside Send
only when exactly one turn runs. A member's last failed turn appears once, by
status, with a way to the member in Members, until dismissed. The Task panel's PauseButton keeps the name "Pause new
work on {task}" with its pressed state, sends the policy revision it showed,
and on a conflict shows the current state without sending again.

## Consequences

- Member permission requests are answerable inside the Workspace; Needs you,
  the bell, the Task panel, the strip and notifications share one source and
  resolve together.
- General no longer shows a row per routing failure, and a failed send is
  recoverable without duplicates.
- Not done in the browser: seeding deliveries from the message page (the
  browser reads `/deliveries` instead).
- Each refetch reads the runtime maps and a handful of indexed queries; the
  summary composes one snapshot per Workspace.
- Recorded gaps: questions on work outside any Task stay on the Team surface;
  pending requests are in memory, so a restart drops them with the provider
  process; stopping a turn does not end its work attempt; a proposal declined
  in words stays listed until it is revised, admitted, approved or discarded;
  server-authored notes are English.
- Extends without superseding ADR 0221, 0225 and 0226: authorization, review
  routing and evidence pins are unchanged, and Needs you never admits, approves
  or accepts.
