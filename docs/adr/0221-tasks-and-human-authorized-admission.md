---
type: ADR
id: "0221"
title: "Tasks, and admission authorized by the researcher through the General Agent"
status: proposed
date: 2026-10-19
---

## Context

Until now a researcher dealt with two overlapping "task" objects: a research
question with versioned briefs and rounds (ADR 0212), and execution work items
on a Kanban (ADRs 0215, 0218). A round was started by a browser command; work
appeared as cards. The Research Workspace blueprint (#199) asks for one
user-facing object, the **Task**, that carries a piece of research from
discussion through approval, execution, and review, admitted to the board when
the researcher tells the General Agent (ADR 0220) in conversation — with no
required form or confirmation click — and never because an agent said so.

## Decision

### 1. A Task is a research question; work beneath it is internal

The canonical identity of a Task is the research question's id. There is no
second writable task record: a Task's brief, rounds, findings, and log stay in
`research_store`, its internal work items, attempts, experiments, and
decisions stay in `work_store` and `experiment_store`, and the **Task** is a
read model composed from them plus two small records of this ADR (§2, §5).
Internal work cannot appear on the board by itself and cannot enlarge a Task.

A research question that has not been admitted is a **draft** (a *proposal*).
Drafts are created by the General Agent or by specialists (or by the
researcher in the research panel) and stay off the board.

### 2. Admission is a recorded authorization by the researcher

Only the General Agent admits a Task, acting on a researcher's authorization.
`task_authorizations` records, for each admission (and each later execution or
scope authorization, §3), who acted and which human message authorized it.
The service refuses an admission unless all of these hold, read from persisted
state:

1. the caller is the Workspace's General Agent (ADR 0220);
2. the authorizing message exists in this Workspace's General conversation and
   its author is the *researcher*; agent- and system-authored messages never
   authorize, and a message whose text is entirely quoted (lines starting with
   `>`) is not an instruction;
3. the named brief revision is the question's *current* revision, **and** the
   General Agent posted a top-level proposal of exactly that revision in
   General before the authorizing message (the channel's gapless sequence is
   the clock; only a message posted by the Task service under the key
   `proposal:{question}:{revision}` counts, so a citation planted in a Thread
   does not), so what the researcher authorized is what they were shown;
4. the instruction answers *that* proposal: it names the Task (attaches it) or
   that proposal is the latest one shown before it. When another proposal came
   after, which one the researcher meant is unclear, and the General Agent must
   show the right one again (`task_show`) and ask;
5. the message authorizes nothing else: it is single-use across *every* step
   and Task (`UNIQUE(message)`), so the words that added a Task cannot also
   start it or approve something else, and an instruction cannot be replayed
   for a different Task.

A retry of the same authorized admission returns the same record and the same
board identity, however many callers race (the decisive checks run in the
transaction); a lost acknowledgement in General is posted again on the retry. Ambiguity (no matching proposal, two plausible Tasks) is not
guessed at: the tool refuses and the General Agent asks in the conversation.
The instruction text itself is interpreted by the General Agent; the server
verifies provenance and freshness, not wording, and an @mention alone is
neither required nor sufficient.

The server never reads the researcher's wording; the only message ids it
accepts are those of the researcher's own messages in General, which any member
can list with `general_recent`.

Proposals are displayed by construction: proposing or revising a brief posts a
message in General that cites the question and its revision, so condition 3
cannot be satisfied by a brief the researcher never saw.

### 3. Admission is not execution

Admitting a Task puts it on the board as *Ready*. Beginning execution is a
second authorization (`kind = execute`) by a *later* researcher message,
newer than the Task's last change of stage (so an old, unused message cannot
reopen a finished Task), recorded the same way. It starts a round pinned to
the approved brief revision, seats the General Agent as its coordinator (the
round's Session is the manager's, without linking that Session to the
question: it coordinates many Tasks), and uses the round's limits (ADR 0217)
and the researcher-set experiment envelope (ADR 0213). It is allowed from
Ready, or from Done to iterate, never while a round runs or under review, and a
retry of a half-finished start is checked against the Task as it is now. Neither authorization sets an envelope or raises a limit. A brief
revised after admission is a *proposed* revision: rounds keep the approved
revision until a `revise` authorization approves the new one. Specialists'
proposals and internal work cannot expand scope, because only an authorized
round exists to carry work and the coordinator's work is bounded by it.

### 4. The board shows Tasks: Ready / In progress / Review / Done

Stage is derived: *Done* when the researcher accepted the Task's results
(with a scientific outcome that may be a well-supported negative finding);
*Review* while the General Agent's request for review is open; *In progress*
once execution is authorized; otherwise *Ready*. Waiting for input, blocked,
and paused are conditions derived from open decision requests, internal work
conditions, and the round's pause; they are not stages. Retries, attempts,
rounds, and dependencies are inside the Task. Accepting results and the
scientific conclusion remain separate facts from process exit.

### 5. Review belongs to the researcher

The General Agent reports results and asks for review with evidence (it does
not run or review the specialist work itself). The researcher accepts —
choosing the outcome — or sends the Task back for iteration with a reason;
both are recorded with the brief revision and reported in General. Evidence
checks of ADR 0219 apply to every cited result before acceptance.

### 6. Existing records

Existing questions, rounds, work, Sessions, Teams, and Threads stay readable
and attributable. A question with a round the researcher already started has
an explicit authorization on record, so it is admitted with
`origin = legacy_round` pointing at that round and no authorizing message;
nothing else is admitted retroactively, and no approval is invented for
discussion, drafts, or resolved-without-execution questions. They remain
drafts, visible in the research panel and Resources.

### 7. Trust boundary

The server tells the researcher's messages from agents' by the interface that
posted them: the browser API, authenticated by the Workspace's access token,
posts as the researcher; MCP callers carry per-Session derived credentials and
can only post as agents. Anything that holds the browser token can therefore
author a researcher message; that is the same boundary as every other
researcher command (limits, envelopes, reviews), not something this ADR adds.
Agents are not given that token.

### 8. Conditions, unattached work, and server wording

A Task's condition is derived with this precedence: needs input (an open
question for the researcher, or internal work flagged), paused (a round of the
Task is paused), blocked (all active work is blocked), waiting. Work with no
research question (native candidates created without a round, legacy Team work
outside any research) is not a Task and not on the board; it stays reachable
through the work API and appears in Resources as work outside Tasks (ADR to
follow with the shell). The researcher editing an admitted Task's brief in the
research panel makes a revision above the approved one; it waits for approval in
the conversation like any other change, and `task_show` puts it in front of them.
The text the server posts in General ("Proposed Task…", acknowledgements,
review verdicts) is English; making it a locale-aware message kind is a follow-up
and is recorded as a gap.

## Supersession

This ADR supersedes, for new Workspace work: the statement in ADR 0212 that
the browser starts a round as the sole authorization path (the research panel's
command still works and is the legacy path above); ADR 0215 and ADR 0218's
position that work items are the board's cards (they are now internal; the
work board remains available as the Task's internal work); ADR 0217's routing
of a conversation `request` to a round coordinator as the primary entry (it
remains for legacy rounds; ADR 0217's "admitted round" means a started round and
is unrelated to an admitted Task) and, together with ADR 0220, its executor
creation and self-execution by the coordinator; and, for the conversation, ADR
0216's Threads as the place work is discussed (Threads remain readable; the
single General conversation and Task filtering are the subject of the
conversation ADR). The execution, evidence, and
experiment contracts of ADRs 0213, 0214, 0217 (limits, routes), and 0219
are unchanged.

## Consequences

The researcher states intent in conversation; the server guarantees that
intent came from the researcher, was current, and was used once. A model that
misreads an instruction can ask again but cannot admit work the researcher did
not authorize. Wording cannot be verified by the server, so a careless
authorization is a researcher decision, visible in the record. Admission
requires the proposal to be shown first, which costs one extra message in
General per Task.
