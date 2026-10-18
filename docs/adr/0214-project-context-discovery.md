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
| `session` | conversation id | latest user-visible run id |
| `session_turn` | `conversation_id/run_id` | digest of the turn text |
| `team` | team id | status and last update |
| `team_task` | task id | digest of status, result, verification |
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
  filtered by whole-word text matching over titles and summaries. Each owner is
  scanned for at most 200 recent candidates; the page cap is 50; the cursor is
  opaque. Results beyond the scan cap are flagged `truncated`, not hidden.
- `read(ref, detail, cursor)` returns a document with a summary first
  (`summary`), then selected content (`content`), then evidence or execution
  detail (`evidence`). A document is a list of titled text sections with `truncated`
  flags, related references, and notes; no section exceeds 8 KiB and a
  document is bounded overall. Long lists (a Session's turns) paginate.
- `resolve(refs)` reports availability and the current revision for up to 32
  references, which is what drafts and rounds use to show stale sources.

### 4. Authorization

The caller's Project comes from the HTTP route or, for Agents, from the Session
(never from an argument). Every lookup checks the record's Project. Session
reads exclude hidden revision snapshots and subagent conversations. A turn
that is still running is readable but marked partial. Artifacts resolve through
`WorkspaceService` under the **execution root of the experiment's Team** (the
Project or its worktree), with no symlink traversal, and are read as bounded
text only. A cross-Session turn read is allowed only here, through an explicit
reference; the Composer's current-Session turn checks (§Composer) are unchanged.

### 5. Consumers

Adapters, not new sources of truth: the HTTP routes (researcher and Composer),
a read-only `kubecode-context` MCP server for every Session and Team member
(passive; one fixed set of tools), typed Composer references that carry
`{kind, id, revision}` and are re-validated at dispatch, and external
discussion import/export. Each is specified with the work that adds it; the
semantics above are shared so identity, provenance, and scope cannot drift.

### 6. Non-goals

A vector database, automatic transcript sharing, an embedded browser, remote
execution, and new Agent providers. Cross-RQ references do not change the
one-RQ-per-Session/Team association. Reading never writes.

## Consequences

Discovery quality is bounded by title/summary text rather than semantic
search; the search cap and `truncated` flag make that visible. Because nothing
is copied, deleting a Session or file makes references to it `removed` rather
than preserving a stale copy, which matches the local-only deletion semantics
of the rest of Kubecode.
