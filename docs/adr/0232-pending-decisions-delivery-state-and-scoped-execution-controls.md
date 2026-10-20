---
type: ADR
id: "0232"
title: "Pending decisions, message delivery state, and scoped execution controls are server projections"
status: proposed
date: 2026-10-20
supersedes: "0224 §1, the sentence defining what Needs you gathers (Tasks in Review or with a request for input, and Sessions waiting for a permission answer), as carried by 0228's adapter; 0228 §1 where a permission request opens the Sessions surface, for Workspace members' Sessions; 0217 §1 where a failed route is final, for routes the researcher originated (discussion, mention, ask, request, task_review, decision); 0223 §1-2 where a message that reaches nobody is recorded only as a system note"
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
- proposals the General Agent showed in General and that are not yet admitted,
  or whose shown revision is not yet approved;
- members that need setup.

Each item is keyed by its decision identity (`permission:`, `input:`,
`question:`, `review:`, `proposal:<task>:<revision>`, `setup:`) and appears
once, whichever records refer to it. Task stages and conditions, a run's
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

### 2. Each item opens the context that holds the decision (browser, planned)

The Task inspector for questions and reviews; the proposal message in General
for proposals (admission stays words-only, ADR 0221); for a member's permission
or input request, the prompt above General's composer (public Session) or above
the member's direct-message composer; the Session itself for other Sessions;
the member profile for setup. The browser removes an item only when a newer
snapshot omits it.

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
browser folds a note into its message. `GET /projects/{p}/deliveries` reads
states by message, message pages carry them, and `orchestration_updated`
carries the message id.

### 4. The researcher may re-arm what they originated

A failed route of kind discussion, mention, ask, request, task_review or
decision may be re-queued under the same route identity with one conditional
write, at most three times (`POST /projects/{p}/routes/{id}/retry`). A
conversation route whose Session is gone is not retried. A denied message may
be read again after setup is fixed, at most three times
(`POST …/messages/{m}/reroute`). The runtime's admission de-duplication on the
delivery key, and the one-route-per-source-and-target rule, make every repeat
the same turn. Failure and denial note keys include the retry or reroute count,
and a note already written under its key never aborts a delivery pass.
Dispatch, result, handoff, experiment and agent hand-off routes stay final when
they fail.

### 5. Sending is never blocked and never loses text

A direct message's send reports whether the member started on it or it is
queued, and `GET …/dm/pending` lists queued direct messages so they stay
visible. In the browser (planned), a send the server has not acknowledged stays
as its own in-memory row (not on disk, ADR 0228), and retrying it replays its
client message id.

### 6. Controls name their effect

Stop cancels one named run now; the member's assigned work and its attempt stay
open (a test pins this). Pause is the round execution policy of a named Task,
exposed on the Task detail as `execution` and changed through the existing
round policy endpoint: it stops new work being handed out and lets running work
continue. The experiment envelope's control pauses experiment launches in a
named round. There is no Workspace-wide pause (ADR 0227). The Task detail also
lists `delivery_issues`: decisions on it that did not reach their recipient.

## Consequences

- Member permission requests become answerable inside the Workspace; Needs
  you, the bell, the Task panel and notifications can share one source.
- General no longer needs a row per routing failure, and a failed send is
  recoverable without duplicates.
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
