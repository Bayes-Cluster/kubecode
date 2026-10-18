---
type: ADR
id: "0217"
title: "Orchestrated research execution: routes, round limits, and caller-bound work tools"
status: proposed
date: 2026-10-18
---

## Context

ADR 0215 made work and the round coordinator durable and workspace-owned.
ADR 0216 gave the researcher a shared conversation whose messages can carry an
intent. Nothing yet carries an intent to the Session that must act, lets that
Session create and run work, or bounds what a round may spend. Today a Team
Leader does this by prompt and by a Leader-only tool surface (ADR 0177); a Solo
round has no way to grow. This decision adds the execution layer on top of the
two stores without replacing the Team runtime.

## Decision

### 1. Routes carry intents to Sessions

The server-owned orchestrator turns recorded intents into durable **routes**.
A route is identified by `(source, target)`, so routing the same message, the
same attempt, or the same result twice makes one route.

- A `request` goes to the **coordinator of an admitted round**: the Thread's
  round, else the newest round of its question, else one the message cites. The
  round needs a Session and an open question; if it has no coordinator yet, its
  own Session is seated (epoch 1). A request with no such round is *answered,
  not acted on*: a system note tells the researcher to start a round. A
  message, a mention, or a Thread link never authorizes work or widens a
  budget.
- An `ask` goes to the Sessions it mentions and to no one else.
- Starting an attempt routes a *dispatch* to the executor; an executor's report
  routes a *result* to the coordinator and posts it once to the originating
  Thread.

Routes are written before the intent is claimed, so a crash between the two is
repaired by the next pass. Delivery leases a route with one conditional write,
resolves the recipient **at delivery time** (a coordinator route follows the
round's current holder, so a handoff retargets what was pending), and hands the
prompt to the Session under a delivery key the runtime de-duplicates on. A busy
Session is retried with backoff and is not a failure until it stays busy; a
provider failure is retried a bounded number of times; both end in a visible
`failed` route and a system note in the conversation. `delivered` means the
Session *has the event*. It is not task completion and not experiment
analysis; those remain work and experiment state.

### 2. Round limits belong to the researcher

`round_policies` bounds a round: distinct executing Sessions, attempts open at
once, attempts ever started (retries included), and a pause. Only the
researcher sets them (revision-checked, each between 1 and 1000); defaults
apply to a round without a stored policy. The work store enforces them inside
the same transactions as the commands they limit (`assign`, `begin_attempt`),
so no caller can bypass them, and a replayed dispatch returns its attempt
before any limit is consulted. Work mirrored from a Team counts against its
round. Exhaustion is a typed error the agent can read.

### 3. Agent commands are caller-bound

The `kubecode-work` MCP server is a thin transport over one service. The
caller's Project and identity come from its Session, never an argument, and
every command re-reads its authority from persisted state: the round's current
coordinator row for coordination (holder compared, epoch taken from the row),
the open assignment for execution. A role named in a prompt grants nothing; a
handoff takes effect on the very next call. The server has no tool that sets a
limit, authorizes a round, or edits a brief.

The coordinator can create, update, assign, start, review, close, and hand off
work, and create idle executor Sessions with an installed provider at the
default permission mode. An executor can attach evidence, say it is waiting,
and report its attempt. Either can post to the conversation where it has
standing: a Thread of a round it coordinates, a Thread it was asked in or sent
work from, or the Thread of work it executes. Every command that creates or
starts something is idempotent on a caller-supplied key.

### 4. Credentials

The server uses a token derived per server and conversation, like the context
and Team servers: another server's credential, or another conversation's,
never opens it. It is advertised to every visible Session; what a Session can
do is decided per command.

## Consequences

One round can grow from one executor to several without rebuilding its
history, because tasks, attempts, and results are the work store's, and the
coordinator is a replaceable holder of a fenced epoch. A duplicate request, a
browser retry, a restart, or a second consumer cannot duplicate a task, an
attempt, a route, or a delivery.

Not yet unified, and recorded as gaps: experiments and their waits still
validate against Team tasks, so a native task cannot own an experiment launch;
the Team mailbox, wake scheduling, and Leader-only Team tools are unchanged and
legacy Team work is still operated through its Team (ADR 0215 §5); a round's
limits have an API but no browser control yet (the board in #189 owns it); and
agent-authored conversation messages are text without structured result
payloads (#190). The work server is advertised over HTTP only; Agents without
HTTP MCP support get no work tools.
