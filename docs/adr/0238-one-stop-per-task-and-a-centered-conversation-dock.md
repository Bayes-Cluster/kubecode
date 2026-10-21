---
type: ADR
id: "0238"
title: "One Stop per Task, a folded running list, and one centered conversation column"
status: accepted
date: 2026-10-21
supersedes: "0232 §6, the sentences on Stop in the browser: that Stop cancels one named run and leaves its Task's new work running, that the Working-now strip lists every member turn with its own Stop and sums itself up in one line on a narrow screen, and that General's and the DM's composer offer the same Stop beside Send when exactly one turn runs"
---

## Context

ADR 0232 gave each running member turn its own Stop, named for the turn
("Stop Analyst's current turn"), and repeated it beside Send when exactly one
turn ran. In use this meant two Stops for one thing, a list of rows that grew
with every running turn and pushed the conversation up, and a Stop that ended a
turn while the Task's next turn started straight away, so stopping a Task took
a Stop and a separate Pause in another panel. General and DM messages also read
from the pane's start edge while the composer floated at a different width.

## Decision

### 1. Stop stops the Task

The Working-now strip groups running turns by the first Task each works on.
A Task has exactly one Stop, "Stop {task}": it first pauses new work on the
Task through its round execution policy (`GET …/tasks/{id}` for `execution`,
then `PUT …/rounds/{round}/execution-policy` with `paused: true`, read again
and sent once more on `policy_revision_conflict`, skipped when already paused),
then cancels every turn on that Task (`DELETE /runs/{id}`); if the pause is
refused, no turn is cancelled and the failure is announced. A turn tied to no
Task (a reply in a DM, an answer in General) has "Stop {name}'s reply", which
only cancels that turn. Resuming is the Task's existing "Pause new work on
{task}" control. The composer in General and in a DM no longer offers a Stop;
the strip is the only entry point.

Every Stop shares one behaviour: busy until its turns leave the attention
snapshot (with the existing fallback reload), announced in the strip's status
region when done ("Stopped {task}", "Stopped {name}'s turn"), and on failure
freed, announced ("{task} could not be stopped. Try again.") and followed by a
reload. A coding Session keeps its own composer Stop; it is now busy while its
cancel is in flight and announces a failure the same way.

### 2. Running work folds; decisions do not

One running entry is shown as one compact row on the composer's top edge. More
than one folds into a single pill, "{count} running", that opens a Popover
listing each entry with its members, what they work on, and its Stop. Pending
permission and input prompts are never folded: they stay above the composer,
in a group named "Waiting for you" that is capped and scrolls on a narrow
screen. A member's last failed turn is shown as before.

### 3. One centered column

General's and a DM's message list and the dock below it (strip, outbox,
composer) share one column, centered in the pane and as wide as the composer
(`--ws-composer-width`). The list's scroller still spans the pane, so its
scrollbar stays at the pane's edge; an empty conversation centers its line.

## Consequences

- Stopping a Task ends its work for good until the researcher resumes it;
  stopping a reply ends only that reply.
- A turn that works on several Tasks pauses all of them and is listed under
  its first.
- The strip no longer needs a one-line summary on a phone; the pill is it.
- `kubecode.execution.stopTurn`, `stopHint`, `summary` and `workingCount` are
  removed from every locale.
