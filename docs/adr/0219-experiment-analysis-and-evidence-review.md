---
type: ADR
id: "0219"
title: "Experiment analysis, evidence review, and decisions on native work"
status: accepted
date: 2026-10-18
---

## Context

Experiments (ADR 0213) were owned by Teams: a finished process was delivered to
a Team member's mailbox and the Team Leader recorded a decision. Native work
(ADR 0215) can run without a Team, so a task executed by one Session had no way
to run a bounded experiment, to be told it finished, to record what it meant,
to cite it as evidence that stays checkable, or to ask the researcher
something without stopping. Acceptance (ADR 0215) looked at the references a
task cited but could not tell that a cited file had since changed.

## Decision

### 1. A task owns its experiments

An experiment may carry a native task id and no Team. It is admitted only if
the task is active native work of the same Project and round; every other
rule of ADR 0213 (envelope, authorized commands, budgets, launch keys,
recovery) is unchanged. The executing Session launches with
`work_launch_experiment`; its key is scoped to the task, so no key from another
task returns this task's experiment, and replaying a key returns the same
experiment and starts nothing. A refused launch (unauthorized command,
exhausted budget, deadline) tells the Session why and flags the task for the
researcher. Nothing a Session says widens an envelope.

### 2. A finished experiment owes an analysis

The orchestrator scans finished experiment events of task-owned experiments
and routes each to the task's current executor (else its coordinator) once,
under `(experiment)`. The task moves `executing → analyzing` and the Thread
that started it hears a short note. The route reports a fact; it is not
analysis. The executor records what the result means with `work_decide`,
using the decision kinds of ADR 0213 (further analysis, repair, retry,
follow-up, external wait, researcher input, conclude), a rationale, and
evidence. A retry or follow-up starts the next experiment under a launch key
derived from the experiment, the kind, and the decision key
(`decision:{experiment}:{kind}:{digest}`), so repeating a decision starts
nothing twice and a refused launch records nothing. Distinct decision keys are
distinct decisions; the envelope's launch and concurrency limits bound them.
Launching and deciding are refused while the task is paused or blocked, the
round is paused, or the task is not executing or analyzing. The stage follows
the obligation in both directions: the orchestrator also returns an
`analyzing` task to `executing` when no experiment owes analysis, so a crash
between a decision and the stage move cannot strand it.
When no experiment of the task owes analysis the task returns to `executing`.
A Session cannot report an attempt as completed while a process of the task
runs or a finished result has no decision; a failed or cancelled report is
never blocked. A negative result is evidence, not a failure.

### 3. Evidence is pinned and checked

A result reference is pinned to the revision it has when cited (a file's
content revision, an experiment's state and analysis at decision time, its
artifacts' recorded revisions). Accepting work, by the researcher or by a
coordinator, refuses evidence that changed or was removed since: the answer
names the stale references, the task is flagged for attention, and nothing is
accepted. The researcher, or the round's coordinator (the delegated reviewer), looks at
the change and **re-pins** (`repin` command or `work_repin`), which moves the
pin to the present and clears the evidence flag once nothing cited is stale;
earlier reviews keep the revision they saw. The gate guarantees the change is
noticed and decided on deliberately, not that a person decided. An executor
never moves a pin. Rejecting, and accepting a plan, do not depend on evidence.
Only content-addressed kinds (files, artifacts, experiments, findings,
imports) are pinned; a Thread or task changes constantly without invalidating
what cites it. A file over the asset size limit cannot be fingerprinted and is
cited unpinned, which is an acknowledged gap.

### 4. Questions to the researcher

A Session asks a bounded question about a task (`work_request_decision`, also
the effect of a `researcher_input` decision). It is a durable request with
options and an impact (at most five open per task); it is shown once in the
originating Thread and noted as unresolved in the question's log. The task is
marked as needing input until every open request is answered, without
overriding a condition someone else set. An answer recorded but not yet routed
(a crash between the two writes) is routed by the next orchestrator pass. The
researcher answers in the inspector. The answer settles that question only: it
is routed back to the asker and the Thread once, and never changes a limit,
brief, or approval. Limits change only as an explicit revision by the
researcher (ADR 0217).

### 5. Server-raised attention

The server, not a prompt, raises a task's attention flag when a limit blocks
progress (no more attempts, a refused launch) or cited evidence changed. It
sets `needs_input` with an `attention:` reason only when the task has no
other condition, and clears only its own flag. Pause and resume of limits stay
the researcher's.

### 6. Publication

An accepted or rejected review is published once back to where the work came
from: a note in the originating Thread and, for accepted work, an attributed
observation in the question's log. Neither blocks the review, and nothing is
removed or rewritten.

### 7. The task brief

`work_brief` assembles, from records only, what a Session starting, resuming,
or replacing another needs: the task and plan, the approved brief revision and
its evaluation criteria (the completion conditions), the round's sources with
whether each is still available, earlier attempts, experiments and decisions,
the round's limits and what is used, and stale evidence. A replacement
coordinator or executor therefore reads the same picture as the original.

## Consequences

Native tasks run the same experiment loop a Team does, with the same limits.
The analysis obligation is enforced on the executing Session, not on the
researcher. A pilot with real agents is a measurement, not a gate: the protocol
is recorded at the end of this ADR and no real-agent results are claimed here. Experiments launched by a Team keep ADR 0213's mailbox
delivery unchanged; unifying the two delivery paths is future work.

## Pilot protocol (not yet run)

The behavior above is verified deterministically with scripted sessions. Whether
real agents use the tools well is a separate question, answered by a small,
bounded pilot that is **only run when the maintainer asks for it**. Protocol:

1. One Project with a toy question whose experiment is a deterministic local
   command (for example a seeded script that fails once and then succeeds), one
   round with an envelope of at most 4 launches and 60 s per run, and round
   limits of 2 executors and 3 attempts.
2. One real coordinator and one real executor (any supported agent), a single
   request from the researcher in the conversation.
3. Record, per run: tasks created from the request; whether the executor read
   `work_brief`; launches and refusals; time from experiment end to a recorded
   decision; whether a failed run was analyzed rather than hidden; stale-evidence
   refusals; researcher interventions; total tokens or wall time if the
   provider reports them.
4. Success is *measured*, not asserted: no duplicate launches or tasks, every
   finished experiment has a decision, no limit exceeded, every acceptance
   rests on current evidence. Failures are recorded as gaps on issue #185.

Until a pilot is run, real-agent behavior is an acknowledged gap. At acceptance
of ADRs 0215-0219 (milestone #185) the maintainer chose not to spend on a pilot,
so it was not run and result quality, human interventions, duplicate work, and
resource use with real agents remain unmeasured.
