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
  workspace, choose the sections, and copy it yourself. It never contains
  transcripts, prompts, credentials, file contents, or server paths.

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
