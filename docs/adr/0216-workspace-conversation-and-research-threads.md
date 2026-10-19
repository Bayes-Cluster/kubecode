---
type: ADR
id: "0216"
title: "Shared Workspace conversation with research Threads"
status: accepted
date: 2026-10-18
---

## Context

A researcher starts with a conversation, not a form. Today the only durable
conversation surfaces are provider transcripts (one per Session), the delivery
mailbox between Team members, and the attributed entry log of one research
question (ADR 0212). None of them is a place to talk with the whole Workspace
before a question exists, to keep several research topics apart, or to point
at the tasks and evidence that came out of a discussion. Making the
conversation the Team Leader's transcript would bind it to one Session's
context and lifecycle (the problem ADR 0215 removed for work).

This decision adds a Project-scoped conversation domain beside the research and
work domains. It is a shared record for people and agents to talk in; it is
not a provider transcript, not the mailbox, and not an authority.

## Decision

### 1. Channels, messages, and Threads are Project records

`channel_store` owns:

- **Channel** — a named, Project-scoped conversation. Every Project has exactly
  one *default* channel, created on first use. The model allows more channels;
  creating dedicated ones (for example one per research question) is a
  follow-up and nothing here depends on it. A channel's identity grants no
  execution authority and does not bind its messages to a research question.
- **Message** — immutable, attributed (`researcher`, `agent` with the Session
  that wrote it, or `system`), sequenced per channel (`seq`, gapless, the
  pagination cursor and total order), with a body, typed **mentions**
  (Sessions), typed **references** (the `ContextRef` model of ADR 0214, plus
  `work` and `thread`), and a client message id.
- **Thread** — a focused discussion rooted at one top-level message. It keeps
  its own replies, may be given a title, and may be *linked* to a research
  question (and one of its rounds). Unlinking and relinking never move or
  delete messages: the original conversation is the same records before and
  after. A channel can hold many Threads on different questions.

Messages and Threads reference other records by id and revision; nothing is
copied. A reference is accepted only if the record exists in the same Project.

### 2. Replay never duplicates

A message is submitted with a `client_message_id` that is unique per channel.
Repeating a submission returns the stored message and creates nothing; reusing
the id for different content is refused. Starting a Thread on a message is
idempotent per root message.

### 3. Intents are claimed exactly once

A message may carry an intent: `say` (discussion), `ask` (a targeted question
to the mentioned Session), or `request` (the researcher asks for work to be
organized). An intent is only a recorded request. Persisting, replaying,
re-reading, or re-importing a message never starts anything. The consumer
(the orchestrator, ADR to follow with #188) *claims* the intent by message id;
the claim is one conditional write, so a second claim — a duplicate delivery,
a restarted consumer, a second coordinator — sees `already claimed` and does
nothing. Only the researcher can author a `request`.

### 4. Linking a Thread to a research question

Linking is revision-checked (a stale link is refused with the current
revision), requires a question in the same Project, and requires a round to
belong to that question. It appends a `system` message to the Thread that
cites the question, so the history of "this discussion became that question"
is part of the conversation. Linking does not create a round, approve a
brief, or start work: those stay explicit actions (ADR 0212, ADR 0215).

### 5. Context sources

The ProjectContext reader gains three kinds: `thread` and `channel` (bounded,
attributed pages of messages, read with a cursor, never the whole history) and
`work` (a work item's facets, plan, attempts, and result references). A
`thread` source carries its linked question as provenance, so two questions in
one channel have separate, unambiguous contexts: an agent given a Thread reads
that Thread, not the channel's other topics.

### 6. Events

Every write commits a content-free `channel_updated` workspace event (channel
id, thread id, change word) in the same transaction. A browser that reloads or
reconnects converges by refetching.

## Consequences

The conversation is durable and independent of Sessions, but agents do not
post yet: the store accepts agent-authored messages so the orchestration
child can, and the browser only authors `researcher` messages today. Channel
creation, message editing, reactions, and unread tracking are out of scope.
Thread-to-work derivation (`derived_from`) will gain `thread` and `message`
kinds when the orchestrator creates tasks from a discussion.
