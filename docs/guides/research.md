# Research questions and experiments

[Documentation](../README.md) · [简体中文](../zh-CN/guides/research.md)

A research question keeps a research direction together across Sessions and
Teams: the approved brief, the discussion, the findings with their evidence,
and every round of work. Nothing here starts an Agent by itself — saving a
brief, posting a note, or linking a Session only records it.

## Questions, briefs, and rounds

1. **Create a question** from the Research list in the sidebar. The brief
   (title, question, motivation, hypotheses, constraints, evaluation criteria)
   is versioned; each edit is a new revision and is checked against the
   revision you were looking at.
2. **Discuss** in a linked Session. Pin points as notes or decisions.
3. **Start a round** from the Work tab. A round names the brief revision it
   uses, so later edits never rewrite it; the round is marked when the brief
   has moved on.
4. **Record findings** with their evidence. A statement with evidence is an
   observation; one without stays an attributed interpretation. Agent
   suggestions to change the direction wait for your decision.

## Bringing a discussion in and taking one out

Brainstorming often happens outside Kubecode. From the Discussion tab:

- **Import** pasted text or Markdown with a note about where it came from. It
  is saved as source material attributed to you. Importing starts no Agent,
  records no finding, and changes no brief.
- **Review** the import. Kubecode lists suggestions it recognised (questions,
  hypotheses, constraints, evaluation criteria, decisions, open questions). You
  tick the ones you want and compare them with the current brief; nothing
  changes until you apply. The edit is checked against the revision you are
  looking at, so a newer brief is never overwritten, and the new revision's note
  names the import it came from. A discussion written against an older brief is
  marked so you review it against what is approved now.
- **Start a round** from the Work tab and, if you want, cite imported
  discussions. This is the same explicit round action as always; repeating a
  request reuses the existing round.
- **Export** a bounded discussion packet (brief, progress, findings, evidence
  names, limitations and open questions). You preview exactly what leaves the
  workspace, choose the sections, and copy it yourself. Kubecode adds no
  transcripts, prompts, credentials, file contents, or server paths; text that
  you or an Agent wrote in findings or imports is included as written. Each
  section has its own size limit, and a cut section is marked.

Agents and other Sessions can find and read the same material through the
read-only context tools and the Composer's "Reference Project work" picker;
reading never starts work.

## Letting a round run experiments

By default a round can run no processes. To allow it, tick **Allow this round
to run local experiments** when you start it (or set up execution later) and
fill in the execution envelope:

- **Launches** and **processes at once** — total and simultaneous limits.
- **Longest run** — a process still running at this limit is stopped.
- **Deadline** — no launch after it (blank for none).
- **Stop after failed runs in a row** — launching stops until you intervene.
- **Allowed commands** — one command per line. A launch must begin with one of
  these, token for token; anything else is refused. Further arguments after the
  listed ones are allowed, so list only commands you are content to run with
  any arguments: allowing `sh -c` allows any script.

These limits are enforced by Kubecode, separately from Agent concurrency
settings, and an Agent cannot raise them. Editing the envelope creates a new
revision; work already running keeps the revision it started under.

### What you see

For each round, the **Execution** panel shows the envelope and what is used,
each launched process with its state, whether its result still awaits
analysis, its exit code, output, artifacts, and the Leader's recorded
decisions. A finished process is **Awaiting analysis** until the Team records
what it decided; a turn ending or a message being read does not change that, and
the Team cannot complete while results are owed.

### Controls

- **Pause launches** stops new launches. Processes already running keep
  running. **Resume launches** reverses it.
- **Stop** ends one running process and its children.
- **Cancel execution** stops every running process of the round and closes its
  envelope for good; it asks for confirmation first.
- **Outcome unknown** appears if Kubecode cannot establish what happened to a
  process (for example it was lost during a restart). It is never treated as a
  success and never rerun. Tell Kubecode whether it never started or did
  finish; this is the only way out of that state.
- A reply that grants more budget or scope has no effect until you save a new
  envelope revision.

Logs are kept per process (up to 16 MiB each) and shown as bounded tails; the
process itself is never stopped for writing a lot of output. A process that
ignores a stop request keeps its slot until Kubecode has killed its whole
process group.

### Restarts

Processes keep running if the Kubecode server restarts. On startup Kubecode
reads each process's exit receipt, resumes watching processes that are still
running, and marks anything it cannot account for as unknown.

## Tasks that run experiments

A task executed by one Session can run experiments of its own inside the
round's envelope. On the work board:

- A finished experiment moves its task to **Analyzing** until the executing
  Session records what the result means (more analysis, repair, retry,
  follow-up, waiting, asking you, or concluding). The inspector lists these
  decisions. A failed or negative result is evidence, not an error.
- The inspector's **Questions for you** lists what a Session asked. Your
  answer settles that question only; it never raises a limit or approves
  more work. To allow more, edit the limits or the envelope.
- A card is flagged **Needs input** with an *attention* reason when a limit
  stopped progress or cited evidence changed.
- **Evidence changed** appears when a file or result cited by the task is no
  longer what was cited. Accepting is refused until you look at it and choose
  **Accept current version**.
- Accepted and rejected reviews are posted back to the Thread the work came
  from, and accepted work adds an observation to the question's log.

## Members and the General Agent

Every Workspace has one **General Agent**, its project manager, created when
the Workspace is created (an older Workspace gets it the first time you open
**Settings > Members**). It clarifies goals with you, plans, delegates to
specialists, follows up, and reports back. It does not run experiments, write
code, analyze data, or do other specialist work, and it cannot be assigned
such work, whatever its instructions say.

In **Settings > Members** you can:

- add specialists (analysis, writing, code review, or custom), edit them, and
  remove them; removing a member keeps its history and is refused while it
  still holds open work;
- see when a member needs setup (for example its provider is not installed) and
  retry after fixing it;
- set the defaults new Workspaces start from: the General Agent's provider,
  provider options such as the model, and its instructions. Defaults are saved
  on the server, so every browser agrees, and they do not change existing
  members.

## Putting a Task on the board

A **Task** is a research question that is on the board. It gets there by
conversation, not by a form or a button:

1. Discuss the idea in General. The General Agent (or a specialist) can draft a
   proposal; it appears in General and stays off the board.
2. Refine it by talking: tell the General Agent what to change. Each new
   version is shown in General.
3. When the proposal is what you want, tell the General Agent, in your own
   words, to add it to the board. You do not need to @mention it.
4. To let it start work, tell the General Agent to go ahead. This is a separate
   step from adding it; it sets no limits and no experiment envelope, which stay
   yours.

An instruction only counts if it is your own message in General, is not just a
quote, comes after the proposal you are agreeing to, and has not already been
used for something else. Specialists' messages, agents quoting you, and
replayed text never add a Task. If something is unclear the General Agent asks
in the conversation.

The board shows only Tasks: Ready, In progress, Review, and Done. Waiting,
blocked, paused, and needs-input are shown as conditions. Retries and internal
work stay inside the Task. When the General Agent reports results, you accept
them (choosing the outcome; a well-supported negative finding completes a
Task) or send the Task back with a reason.

## Finding your way around

A new Workspace opens in **General**, where its project manager (the General
Agent) is already waiting. The navigator leads with four places: **General** (the one conversation),
**Kanban** (the one board of Tasks), **Resources** (what the Workspace has
produced, previewed read-only), and **Members** (the agents). **Needs you**
collects what is waiting for you — results to review and input an agent asked
for — and each item opens the place to act. Sessions, Teams, Threads, and
research questions are still there, below and under *History and execution*.

Choosing a Task chip on a message, a card, or an item in *Needs you* opens the
Task beside the list; closing it brings you back to the message you came from.
On a phone the list and the detail are separate screens. The address bar always
names where you are (everything after the `#`), so reloading, going Back, and
sharing the link all return to the same place. Files and Git open from the
panel buttons in the title bar when you want them; they are not always on
screen beside General or the board.

### Finding and citing what the Workspace produced

**Resources** and the search box in the title bar (*Search this Workspace*)
look through Tasks, findings, experiments and artifacts, discussions, and
Project files by title, summary, and file path; *History* (execution history)
is searched only when you turn it on. The search always says what it covered, and message
text and direct messages are never searched. Choosing a result previews it
beside the list; it never takes you away, and *Open Task*, *Open Thread in
General*, or *Open in execution history* in the preview go where it lives.

To cite something in General, use **Add context** in the composer: find it,
preview it, and choose **Attach this version**, or press Enter on a result to
attach its current version. You return to the same draft, with the caret where
it was. **Browse in Resources** looks there instead; **Add to message** in a
preview brings you back. A cited item shows its name and version, and says
*Changed since cited* or *No longer exists* when that happens. A message cannot
be sent while it cites something that no longer exists.

## The Kanban and deciding on results

**Kanban** shows only Tasks that are on the board, in four columns: Ready, In
progress, Review, and Done. Why a Task is not moving (waiting, blocked, paused,
needs input) is shown as a badge on its card, and a card says when its brief
changed after you approved it. You do not add Tasks here: tell the General Agent
in General, in your own words, to add a proposal. Proposals that are not on the
board are listed under the columns.

Open a card to see where the Task stands, your words that added it, the project
manager and the specialists, questions waiting for you, and — when the General
Agent asks for your review — the results with their evidence. Look at the
evidence; if a file or result changed after it was attached, you are told, and
you accept its current version before accepting the results. Choose what the
result showed (a well-supported **negative result** is a valid outcome and
completes the Task), or send it back with a reason. The outcome is posted back in
General with a link to the Task. To keep going, tell the General Agent to carry on
with the same Task; it stays one card.

## Who reads what you write in General

- A message that names no one goes to the **General Agent**, the project
  manager. You can think out loud with it, refine a proposal, and tell it, in
  your own words, to put a Task on the board; you do not need to @mention it.
- **@mention** a member to ask them directly. Only the members you name receive
  the message, and a mention alone never starts work.
- Members can hand work to each other in General. You see every hand-off, who
  wrote it, and who it was handed to. A member's message is a report or a
  request, never your authorization, and a chain of hand-offs stops after a few
  steps and waits for you.
- Messages about a Task carry a **Task chip**; choose a Task in *Show messages
  about* to see only those messages. It is a view of the same conversation, not
  a copy. **Reply** cites a message, and the citation jumps back to it. Routing
  notes are collapsed to one line you can expand.

## Private messages with a member

Choose **Message … privately** on a member (Settings > Members) to open a
private conversation. Only you and that member see it: other members cannot
read, search, mention, or cite it, and nothing in it is posted to General.
**Share to General…** lets you pick turns, add a note, and read the exact text
that would be posted; it is posted only when you confirm that preview, and not
if the conversation changed after you previewed it. What you share is an
ordinary message from you in General, so it reaches the project manager like any
other.

## Writing in General and Threads

General and Threads use one composer (direct messages with an Agent will use it
too once they ship):

- **Enter** sends; **Shift+Enter** starts a new line. On a phone or tablet
  Enter starts a new line and the arrow button sends. **Ctrl/Cmd+Enter** always
  sends. While an input method (for example for Chinese or Japanese) is
  composing, Enter confirms the candidate and never sends.
- Type **@** to mention a member; use the arrow keys and **Enter** (or
  **Tab**, once you have typed part of a name or moved with the arrows) to pick
  one, **Esc** to close the list. A mention addresses the member in the
  message; it does not authorize any work.
- The arrow button sends. It stays available while agents are working. A
  session's **Stop** button names the Agent it stops. Approving a Task or
  accepting evidence is always an explicit, text-labelled button, never an
  icon alone.
