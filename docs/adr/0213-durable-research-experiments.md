---
type: ADR
id: "0213"
title: "Durable research experiments, waits, and execution envelopes"
status: proposed
date: 2026-10-17
---

## Context

ADR 0212 lets a research Team run inside an RQ round, but a Team can only
express work as ACP turns. A real experiment outlives a turn: the Agent starts
a process, has nothing to do until it ends, and must be woken with the result.
Today a completed turn without a Team result is a *missing report* (one
reminder, then the attempt fails), pausing a Team fails its attempts, and
nothing records that an Agent is legitimately waiting. Keeping a turn open
wastes a concurrency slot and does not survive a restart.

The runtime must own durable facts (what was launched, under which authority,
what was observed, who owes the next step) while the existing Leader stays the
semantic planner. Process exit, experiment outcome, analysis, Team completion,
and RQ resolution are different facts and stay different states.

## Decision

### 1. Domain and ownership

A new `experiment_store` owns four tables on the single SQLite owner (ADR
0200), created by an idempotent `ensure_schema` that `TeamStore` also calls,
because Team transitions write them in their own transactions (the same
arrangement as ADR 0212's pending outcomes). Every row is scoped by Project
and cites its RQ round and Team; a foreign Project, round, Team, or task is
indistinguishable from a missing one.

- `research_envelopes` (+ immutable `research_envelope_revisions`): the
  researcher-approved execution envelope of one round.
- `experiments`: one launch attempt.
- `experiment_waits`: a member's recorded obligation to resume.
- `experiment_events`: committed observations (the delivery trigger).

Decisions and attention records are added by the continuation work (§7).

### 2. The execution envelope is the authorization

An envelope is set by the researcher (never by an Agent) per round and holds:
`max_launches`, `max_concurrent`, `deadline_at`, `max_runtime_secs` per
process, `max_no_progress`, and `allowed_commands` — a list of argv prefixes.
Without an envelope nothing can launch. A launch is admitted only when its argv
starts with an allowed prefix, so a prompt, an MCP call, or a Standard-mode
Team can never run a command the researcher did not name. This is explicit
pre-authorization, not a bypass of provider-native permissions: provider tool
calls inside an Agent turn keep their existing permission path unchanged.

An envelope has a monotonic `revision`; every revision is immutable and edits
require `expected_revision`. An experiment records the revision it was admitted
under (`policy_revision`) and keeps running under it: raising a limit later
never retroactively widens running work, and lowering one never silently kills
it. The envelope also has a state — `active`, `paused`, `closed` — changed
only by the researcher (§6).

### 3. Reservation accounting

Admission is one `IMMEDIATE` transaction that checks the envelope and inserts
the experiment row together, so the budget is reserved before any side
effect. A launch request carries a `launch_key` unique per round: replaying it
returns the existing experiment and consumes nothing; reusing it for a
different command is refused. A deliberate retry is a *new* key and a new
reservation.

- *Launch budget*: reservations ever made, excluding attempts that the
  researcher or Leader reconciled as never started.
- *Concurrency*: experiments in `reserved`, `launching`, `running`,
  `cancelling`, or `unknown`. An uncertain process keeps its slot until it is
  reconciled; a slot is never released while work may still be running.
- *Deadline*: no admission after `deadline_at`.
- *No progress*: after `max_no_progress` consecutive finished attempts that
  failed, timed out, or ended unknown, admission refuses until the researcher
  intervenes. The runtime refuses; a prompt cannot override it.

These limits are independent of Agent concurrency (`max_parallel_runs`).
Concurrent updates and reservations serialize on the transaction; an envelope
edit with a stale revision is a conflict that changes nothing.

### 4. Experiment states

`reserved → launching → running → exited | timed_out | cancelled`, with
`failed_to_start` (spawn refused) and `unknown` (identity or outcome cannot be
recovered). `cancelling` sits between a cancel request and its observation.
`exited` records the exit code or signal; a non-zero code is an observation,
not a verdict on the science, and exit code zero is never proof of success.

`analysis` is a separate axis: `none` until the process is terminal, then
`pending` until an explicit analysis decision (§7) moves it to `analyzed`.
A mailbox acknowledgement means the event was read, not analyzed.

`unknown` is terminal for automation: nothing resubmits it. It leaves the state
only through an explicit reconcile naming the truth (`not_started`, which frees
the launch reservation, or `finished`, with an optional code), recorded with
the actor.

### 5. Waits

A wait records the awaited experiment, the responsible member, the expected
follow-up, a deadline, and a state `open | resolved | expired | cancelled |
reassigned`. Registering a wait is a Team tool call by the owner. If the
experiment is already terminal the wait is created resolved and the result is
already owed.

- **Missing report.** A turn that ends with no result but with an open wait
  for that member is not a missing report: no reminder, no failure. Ending
  with neither still follows the existing path.
- **Resolution.** The terminal observation resolves the experiment's open waits
  and enqueues the mailbox event in the same transaction (§6 delivery).
- **Expiry.** A wait past its deadline expires and produces its own event, so a
  stuck experiment cannot hold a Team forever.
- **Responsibility.** If the owner is removed or unavailable, the event routes
  to the Leader, who reassigns; the work is never implicitly rerun.

Team completion is blocked while an experiment is active, an analysis is
pending, or a wait is open. Teams with none of these complete exactly as
before.

### 6. Process runner and delivery

The local runner (a service wired in `AppState`, recovered at startup before
the supervisor) launches `argv` directly — no shell expansion of user text —
through a tiny fixed `/bin/sh` wrapper that writes a pid file, applies a file
size limit (`ulimit -f`), redirects stdout and stderr to Runtime-owned log
files, and atomically writes an exit **receipt**. The wrapper leads a new
process group so the whole tree can be signalled. Because output goes to files
and the receipt is written by the wrapper, the experiment survives a Runtime
restart and its outcome stays recoverable.

Identity is `(pid, process start ticks, boot id)`, never a pid alone. Recovery
at startup is a decision table: a receipt means exited with that code; a live
process with matching identity is adopted; a missing process with no receipt is
`unknown` (or `cancelled` if a cancel was already requested); a `launching`
row with no pid evidence is `unknown`. Nothing is blindly relaunched.

Delivery reuses the Team mailbox. The terminal observation, the wait
resolution, the analysis obligation, and the mailbox row commit in one
transaction keyed by `(experiment, event kind)`; notifications are hints and
the committed rows are authoritative. The existing wake path starts the owner
if idle and leaves a busy owner alone; paused Teams keep the message pending.
The 30-second supervisor re-checks undelivered events, expired waits, and
acknowledged-but-unanalyzed results, with bounded reminders and a
no-progress cap that escalates to attention instead of waking forever.

**Pause and cancel.** Pausing the envelope (or the Team) stops *future*
launches and leaves running processes alone. Cancelling terminates the
round's running process groups and closes the envelope. Removing a member
reassigns its waits to the Leader; removing the Team terminates its processes
before its rows are deleted. Local-only removal semantics are unchanged: no
Project directory or provider history is touched.

Logs live under the Runtime state directory, capped, and are served as bounded
tails. Declared artifacts are Project-relative paths resolved through
`WorkspaceService`, recorded with their content revision at exit; a missing or
changed artifact is reported as such.

### 7. Continuation

(Defined with the Leader-decision work.) The Leader records a structured
decision per finished experiment — further analysis, repair, explicit retry,
follow-up, external wait, researcher input, or conclusion — with its
rationale and evidence references. A decision is idempotent per experiment and
kind; a follow-up launches with a key derived from the observation, so one
observation can never fan out into duplicate launches. Scope or budget changes
go through the existing user-input path and take effect only as an explicit
envelope revision.

### 8. Consequences

`libc` becomes a direct dependency (already in the build graph through other
crates) for process-group signalling. No cluster scheduler, container
requirement, SSH/Slurm adapter, or GPU accounting is introduced; those remain
follow-ups. ADRs 0200, 0205, 0210, and 0212 are extended, not superseded.
