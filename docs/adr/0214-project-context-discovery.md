---
type: ADR
id: "0214"
title: "Project context discovery, references, and research handoff"
status: proposed
date: 2026-10-18
---

## Context

Research work lives in several canonical owners: research questions and
findings (ADR 0212), Sessions with their own provider histories, Teams and
tasks, experiments and their artifacts (ADR 0213). Today an Agent starting
fresh in a Project cannot find any of it unless a person pastes it in, the
Composer can reference only the *current* Session's turns, and discussion that
happens outside Kubecode has nowhere to go.

The goal is reuse without copying: a new Agent or researcher can discover
relevant prior work, read a compact summary first, pull detail and evidence on
demand, and continue inside the researcher's approved direction. Reading is
passive. It never starts an Agent, assigns work, approves a brief, or grants
execution authority, and a claim being readable does not make it verified.

## Decision

### 1. One read-only reader over the canonical stores

`ProjectContext` is a service composed in `AppState` that borrows the existing
stores and `WorkspaceService`. It owns **no data**: no content store, no index,
no embedding service. Every answer is computed from the owner on demand, so it
cannot drift from the owner. All entry points take a `project_id` first;
another Project's record is indistinguishable from a missing one.

### 2. Typed source identity

A reference is `{ kind, id, revision? }`:

| kind | id | revision means |
| --- | --- | --- |
| `research` | RQ id | brief revision |
| `round` | round id | phase and pinned brief revision |
| `finding` | finding id | immutable (`1`) |
| `session` | conversation id | digest of the latest turn id and status, title, archive state |
| `session_turn` | `conversation_id/run_id` | digest of status and the first 8 KiB of the turn text |
| `team` | team id | digest of status, last update, goal, final summary |
| `team_task` | task id | digest of status, result, verification, plan, description |
| `experiment` | experiment id | digest of state, analysis, exit |
| `artifact` | `experiment_id/path` | content revision when the process ended |

`revision` is a **fingerprint, not a snapshot**. Comparing a pinned revision to
the current one yields `available`, `changed`, or `removed` (the vocabulary of
ADR 0212 §5). A changed or removed source is always reported as such; old bytes
are not recoverable from a fingerprint and the reader never pretends they are.
**Live lookup** (no revision, the current state) and **pinned evidence** (a
revision recorded when something cited it) are distinct: a pinned research
reference reads the pinned brief revision and says a newer one exists.

### 3. Progressive, bounded reads

- `search(query, kinds, limit, cursor)` returns metadata items — reference,
  title, a ≤280-character summary, provenance, availability — newest first,
  filtered by case-insensitive text matching: every query word must occur in the
  title or summary (a word may match part of a longer word). Each owner is
  scanned newest first for at most 200 candidates and one search gathers at most
  2,000 in total; the page cap is 50; the cursor is opaque. Anything left out by
  either cap sets `truncated` on the page rather than being hidden. Artifact
  items carry the revision recorded when the process ended and are listed as
  `available`; `read` and `resolve` report their current state.
- `read(ref, detail, cursor)` returns a document with a summary first
  (`summary`), then selected content (`content`), then evidence or execution
  detail (`evidence`). A document is a list of titled text sections with `truncated`
  flags, related references, and notes; no section exceeds 8 KiB and a whole
  document is cut at 32 KiB, with a note. Long lists (a Session's turns)
  paginate. A Session or turn read returns message text; tool calls and other
  execution events are not included. `read` of a missing or removed record is
  `not found` (as for another Project's record); only `resolve` reports
  `removed`.
- `resolve(refs)` reports availability and the current revision for up to 32
  references, which is what drafts and rounds use to show stale sources.

### 4. Authorization

The caller's Project comes from the HTTP route or, for Agents, from the Session
(never from an argument). Every lookup checks the record's Project. Session
reads exclude hidden revision snapshots and subagent conversations in every
path (search, read, resolve, turn reads). A turn
that is still running is readable but marked partial. Artifacts resolve through
`WorkspaceService` under the **execution root of the experiment's Team** (the
Project or its worktree), with no symlink traversal, and are read as bounded
text only. A file is opened once without following a final symlink or blocking
on a FIFO, and its revision is computed from the same bytes that are shown. If
the Team that ran the experiment no longer exists the artifact is unavailable;
the reader never substitutes the Project's same-named file. A cross-Session turn read is allowed only here, through an explicit
reference; the Composer's current-Session turn checks (§Composer) are unchanged.

### 5. Consumers

Adapters, not new sources of truth: the HTTP routes (researcher and Composer),
a read-only `kubecode-context` MCP server for every Session and Team member
(passive; one fixed set of tools: `context_round`, `context_search`,
`context_read`, `context_resolve`; HTTP-advertised to every Session, in-process
for Team members whose Agent lacks HTTP MCP, none for a Solo Session on such an
Agent, which relies on the round prompt; Solo and Team rounds share one
delivery function), typed Composer references that carry
`{kind, id, revision}` and are re-validated at dispatch, and external
discussion import/export. Each is specified with the work that adds it; the
semantics above are shared so identity, provenance, and scope cannot drift.

### 6. Non-goals

A vector database, automatic transcript sharing, an embedded browser, remote
execution, and new Agent providers. Cross-RQ references do not change the
one-RQ-per-Session/Team association. Reading never writes.

### 7. Extending the reference kinds

A new kind is additive: one variant in the Rust `ContextKind`, the mirrored
TypeScript union, a lookup and read arm in `ProjectContext`, and tests for
Project scoping and for changed/removed reporting. Consumers must treat an
unknown kind as unsupported, never as a different kind.

### 8. Imported discussion and the discussion packet

Discussion held outside Kubecode is **source material**, not a finding.

- **Identity and persistence.** An import is an immutable row of the research
  question (`research_imports`): the normalized text (at most 64 KiB, line
  endings unified, NULs removed), an origin label (200 characters), its format
  (`paste` or `markdown`), the brief revision the researcher says it was about,
  and the SHA-256 digest of the text. Its reference is `{kind: import, id,
  revision: first 16 hex of the digest}`, usable as a round source
  (`SourceKind::Import`), by the context tools, and in the Composer picker. At
  most 50 per question. The same `client_request_id` returns the original
  import; reusing it for different text is refused. Imports are never copied
  into Agent transcripts and never edited.
- **Attribution.** The author is always the researcher. Nothing an import
  contains is a finding; the reader labels it as unverified source material.
- **Review.** Candidate questions, hypotheses, constraints, evaluation
  criteria, decisions, and open questions are derived deterministically from the
  stored text (headings, labels, list items, standalone questions) and are not
  persisted. They are suggestions only.
- **Applying.** The only way to change the brief is the existing
  revision-checked edit (`expected_revision`). It may name `import_id`, which
  the revision note records, so the change stays traceable to its source.
  Decisions are recorded as researcher decision notes. A newer brief makes the
  edit fail with a conflict; nothing is silently replaced. An import written
  against an older revision is reported `stale` so it is reviewed against the
  approved brief.
- **Handoff.** A round is started only through the existing round action. A
  round may cite imports as sources; its brief revision, instruction, sources,
  and execution authorization are pinned exactly as before and repeated
  requests reuse the round's idempotency key.
- **Export.** `GET .../export` builds a packet of at most 32 KiB from the
  approved brief, round and experiment status (no commands or logs), attributed
  findings, limitations and open questions (including those found in imports),
  and evidence *names* (Project-relative paths and short ids, never contents).
  The researcher chooses sections and previews the exact text and a plain
  statement of what is and is not included before copying it; Kubecode sends
  nothing anywhere.

## Validation status

Deterministic fixtures cover the reader, the HTTP adapter, the MCP transport
(initialize, tool listing, a tool call), tool scoping, passivity, and round
delivery for a Solo Session and a Team member. **No real Claude Code, Codex, or
OpenCode run has called the context tools or honored a pinned brief**; whether
each provider surfaces the server's instructions and uses the tools well is
unvalidated and is recorded as an open gap on the milestone.

Known limits of the Composer references (#176): a Session with a running turn
cannot queue or steer a prompt that carries any typed reference (an existing
rule for every typed kind, because the queue stores plain text); the in-Composer
preview is read-only and does not navigate to the object; section headings and
notes in a preview are server-authored English; the persisted turn records the
resolved reference text (kind, title, revision, author) rather than a typed
chip.

## Consequences

Discovery quality is bounded by title/summary text rather than semantic
search; the search cap and `truncated` flag make that visible. Because nothing
is copied, deleting a Session or file makes references to it `removed` rather
than preserving a stale copy, which matches the local-only deletion semantics
of the rest of Kubecode.
