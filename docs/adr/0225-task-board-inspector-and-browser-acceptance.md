---
type: ADR
id: "0225"
title: "The Task board, the Task inspector, and browser acceptance with member fixtures"
status: accepted
date: 2026-10-19
supersedes: "0218 where the Workspace Kanban shows work items instead of Tasks"
---

## Context

ADR 0221 made a Task a research question admitted by the General Agent on the
researcher's words, and ADR 0224 gave the Workspace its navigation and detail
area. What remained was the researcher's side of a Task: seeing proposals,
seeing exactly one board, and deciding on results with the evidence in front of
them — and proving the whole story in a browser without a real model.

## Decision

### 1. One board of Tasks

The Kanban entry shows the `GET …/tasks/board` model and nothing else: admitted,
top-level Tasks in **Ready**, **In progress**, **Review**, and **Done**. Waiting,
blocked, paused, and needs-input are *conditions* badged on a card; a changed
brief (`revision > approved_revision`) and "waiting for you" are badges too.
A card names the project manager and the specialists separately. Proposals that
are not on the board are listed apart as drafts. There is no way to admit a Task
from the board: admission is the General Agent's act on the researcher's words in
General. Retries, attempts, and internal work items stay inside the Task and are
listed in its inspector; the work-item board remains the Team surface.

### 2. Proposals are shown as what they are

The General Agent's proposal messages (key `proposal:{task}:{revision}`) render
with their revision, whether the Task is on the board, and — while it is not — the
reminder that the researcher asks for changes or says in their own words to add
it. A message about a Task carries a Task chip that opens the Task beside the
conversation; Task outcomes posted by the service are shown in full, while
routing notes stay collapsed.

### 3. The Task inspector

Above a Task's research workspace (brief, discussion, work, findings, evidence
readers) the inspector shows from `GET …/tasks/{id}`: stage and condition; the
brief revision against the approved one, with a notice when the brief changed
after approval and work continues on the approved revision; the researcher's own
words that added the Task, with a jump to that message; the project manager and
the specialists; requests for input with their options (answered in place);
internal work; earlier reviews; and the **review** the manager asked for: its
summary, the cited evidence (opened in the shared evidence reader), and the
decision.

The decision is the researcher's. Accepting requires choosing what the result
showed; a well-supported negative result is a valid outcome that completes the
Task; sending back requires a reason. Evidence that changed or disappeared since
it was attached is listed before acceptance: acceptance is disabled while any
remains, a changed record can be accepted at its current version after looking at
it (re-pin), and the server independently refuses an acceptance over changed
evidence (`409 work_evidence_stale`), after which the inspector reloads. A review
that was already decided or replaced is reloaded, never double-decided. The
outcome returns to General as a Task-linked message.

### 4. Browser acceptance with member fixtures

The browser test plays the researcher. Members are deterministic fixtures: the
fixture provider records the MCP servers the runtime hands each Session (it
declares HTTP MCP support) and the prompts that reach it; the test waits for the
real routing to prompt a member, then acts *as that member* through its own
authenticated MCP endpoint. Every action therefore passes the production tools,
authority checks, and stores, and nothing is stubbed. The scenario covers:
discussion; a proposal and a revision in conversation; a specialist's claim and a
quoted line failing to admit; the researcher's instruction without a mention; a
brief changed after approval and its approval; "go ahead" with a mention; the
manager's delegation and its refusal to execute; public specialist progress and
manager follow-up; review over evidence that changed; an accepted negative
finding; iteration as the same card; a dropped connection converging; and a phone
viewport. A service-level scenario
(`workspace_blueprint_acceptance`) repeats the authority, restart, replay,
cross-Workspace, and direct-message isolation claims without a browser.

What these do not show is a real model's judgement: whether it asks a good
clarifying question, resolves "the task we discussed" to the right Task, or writes
a faithful summary. That needs a real provider and is validated by hand, outside
CI.

## Consequences

The old work-item board is no longer reachable from the Workspace navigation;
its smoke scenario was retired in favor of the scenario above, and its unit tests
and the Team surface remain. The fixture provider answers prompts routed from the
Workspace conversation at once and holds other prompts for 20 seconds, as before.
