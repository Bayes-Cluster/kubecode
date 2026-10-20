---
type: ADR
id: "0231"
title: "Workspace search with a named scope, Project files as references, one preview surface, and versioned references"
status: proposed
date: 2026-10-20
supersedes: "0214 §3, the sentence 'Artifact items carry the revision recorded when the process ended and are listed as available', and the single `truncated` flag as the only scope signal of a search page; 0214 Validation status, the known limit 'the in-Composer preview is read-only and does not navigate to the object', for the Workspace composer only; 0224 §2, the Resources bullet (where 0228 has not already superseded it)"
extends: "0214 §2 and §7 (adds the `file` kind), 0214 §3 (pages name their scope, reads name the revision they show, resolve returns titles), 0216 (researcher message references are pinned when posted), 0228 (Resources hosts the inspector; rows open through it), 0227 (ReferenceChip is the only rendering of a reference)"
---

## Context

Researchers must find Workspace material, check it, and cite it without losing
the message they are writing. Before this decision:

- Resources was the Session Composer's picker in a browsing mode. It had its
  own inline preview beside the evidence reader, and the two disagreed on
  loading, changes, and removal. Its Open action left the view, and only some
  records had anywhere to go.
- Project files could not be found or cited from General. Search covered
  record titles and summaries only.
- A search page reported truncation as one flag that the browser ignored. A
  removed artifact was listed as available.
- The General composer attached whatever revision a list row carried, often
  none or a stale one, without the researcher reading it. The Task filter's
  own reference and a shared direct message's Task reference carried none.
- Cited objects were shown as eight characters of an id.
- A pinned research brief was reported with the current revision while the
  older brief was shown.
- Query, filter, selection, and position were lost on every view switch.

## Decision

This ADR covers the server and the browser. The server parts (§1, §2, §3, and
the server half of §5) are implemented; the browser parts (§4, the browser
half of §5, and §6) are planned and land in later slices of #219.

### 1. Project files are a reference kind

`file` joins the reference kinds under 0214 §7. Its id is a Project-relative,
`/`-separated path. Its revision is the fingerprint work evidence already pins
(SHA-256 of the bytes, or `large:<size>:<mtime>` above 8 MiB), so a file cited
by a message, a round, or a review compares the same way everywhere.

Files are found, resolved, and read only through `WorkspaceService`, under the
Project root:

- An id with a leading `/`, a `\` or NUL, an empty, `.` or `..` component, or a
  `.git` component is never a file; it is not found. Other dot paths are
  readable when named explicitly, as work evidence allows, but are never
  listed.
- Lookup and resolve fingerprint the file through no symlink; a directory, a
  FIFO, or a path through a symlink is not a file.
- A read opens the file once, never following a symlink and never blocking on
  a special file, and fingerprints the same descriptor it reads. A file is read
  a page (8 KiB) at a time at every detail, cut on character boundaries. The
  next-page cursor carries the byte offset and a tag of the revision it was
  issued for; a file that changes between pages is reported `changed` with no
  text and no cursor, so two versions are never spliced together. A forged
  cursor is refused.

Search finds files by the words of their path (every word must appear in the
lowercase path), newest first, in a bounded breadth-first walk: at most 5,000
directory entries and 16 levels, never through a symlink, skipping hidden,
generated, non-UTF-8, and Git-ignored entries (one `git check-ignore` per
level) before descending. It keeps the 200 most recently modified matches and
reports when it stopped. There is no index (0214 §1). A file's time is written
in the stores' `YYYY-MM-DD HH:MM:SS` UTC form so it sorts among record times.
Hits are not hashed; resolve and read fill the revision.

Files are searched only when a caller names the kind. An empty kind list keeps
every existing caller's scope (every kind but `file`), so the context tools and
the Session composer never walk the disk unasked. The context tools therefore
let every Session, including the restricted manager (0226) and direct-message
Sessions, read and resolve Project files read-only, bounded, and never inside
`.git`. Those Sessions can already read the files with their own tools.

A Session composer keeps its own file contract under the Session's execution
root and does not accept a `file` Project reference. File paths never enter
routes, stored places, or analytics.

### 2. A search names its scope

A search page states three things beside its items:

- `searched`: the kinds it covered, in declaration order (a Session turn is
  read through its Session and is never a search row);
- `truncated_kinds`: the kinds an owner's scan cap, the candidate budget, or
  the file walk cut short; `truncated` stays, true exactly when this is not
  empty;
- `counts`: matches per searched kind before paging, zero included, a lower
  bound for a truncated kind.

The browser will search explicit sections: Tasks, findings, experiments and
artifacts, discussions, files, and, when chosen, execution history. It will say
so in words, say that titles, summaries, and file paths are matched, and say
that message text and direct messages are never searched.

Results are identified by Workspace and reference and open within that
Workspace. A result or resolution for a Workspace that is no longer active is
discarded. Session search keeps its name and place. Direct-message Sessions
stay invisible to search, resolve, and read in every path (0223).

### 3. Availability is honest

Artifacts and files on a returned page are checked for existence with a
metadata check (no hashing) and are listed as `removed` when gone. Read and
resolve continue to report `changed` and `removed` against a pinned revision.

A read states `shown_revision`, the revision whose content its sections show:
the pinned brief revision when an older brief is shown, the revision of the
bytes of an artifact or file page, and none when nothing of the record is
shown (removed, or changed while it was being paged). A file that is not UTF-8
shows no text; its `shown_revision` is the version that was found to be
unreadable.

Resolve returns a record's current `title` only when the record is visible in
this Project, including an artifact whose file is gone; never for a missing,
private, or foreign record.

### 4. One preview surface (planned)

Every read-only view of a Workspace record will be one component over the 0214
reader: the inspector's resource entry (0228), evidence a Task cites at its
pinned revision, the add-context step of the Workspace composer, and the
Session composer's picker. File evidence is read through the context reader,
with the fingerprint it is pinned with.

The preview reports the revision it displayed (`shown_revision`), only after a
successful display. That report is what evidence acceptance (0226) and "attach
this version" bind to. The preview never changes content under the reader:
when the record changes, it says so and offers the current version.

Choosing a record in Resources or Workspace search previews it in the
inspector, beside the list or as a screen on narrow layouts. Going to the
record's home (its Task, its Thread in General, its Session) is an explicit
action inside the preview. Reference chips keep 0228's mapping.

### 5. References carry the version that was seen

When a researcher posts a General or Thread message, or shares a direct
message, the server resolves every reference first (implemented):

- a reference without a revision is pinned to the record's current revision,
  including the Task filter's own reference and a share's Task reference;
- a revision the client supplied is kept even if the record changed since,
  because it is what the researcher saw;
- a reference to a record that no longer exists is refused with a 400;
- a retried send with a stored client message id replays the stored message
  before anything is resolved again (the stored revisions fill a retried
  reference that carries none), so a retry never fails because a record was
  removed after it was accepted, and a reused id with a different message is
  still a conflict.

Agent posts (`general_post`, work posts) are unchanged. No schema changes:
stored references already hold `{kind, id, revision}`.

The Workspace composer will attach a reference with a revision (planned): the
revision the preview displayed when the researcher previewed it, or the current
revision resolved at the moment of attaching when they attached from the list.
Every reference, in drafts and in messages, will show its kind, its title
(never an id), the cited version, and in words whether it changed, no longer
exists, or is not available here. A removed reference cannot be sent; a
changed one is sent at the version that was seen. Revisions are fingerprints,
not snapshots (0214 §2).

Draft references will live in the in-memory place memory of 0228, at
`<draftKey>#references`, one per record. Finding, previewing, browsing
Resources, and attaching return to the same draft: the same Workspace, Task
filter, Thread, reading position, focus, and caret. Attaching a Task links the
message to it and never authorizes admission or execution (0221).

### 6. What stays private (planned)

The search query, the chosen sections, and the results will live only in page
memory. They never go into routes, stored places, or analytics.

## Consequences

- One reader means one set of loading, changed, removed, and unavailable rules
  across Resources, review evidence, and both composers once the browser slices
  land. Evidence files are read with the fingerprint they are pinned with.
- A search that includes files costs a bounded directory walk per request
  (about 34 ms for a 50,000-file Project in a debug build, measured by an
  ignored test in `server/tests/workspace.rs`). Its truncation is visible per
  kind. Hashing is spent only on resolve and read.
- Reading a file page fingerprints the whole file (bounded at 8 MiB), so
  paging a large text costs a hash per page.
- Clients and agents receive additive fields (`searched`, `truncated_kinds`,
  `counts`, `shown_revision`, `title`). Old messages without versions resolve
  as current.
- Researcher-posted references now always carry revisions, and a post that
  cites a removed record fails where it used to be stored.
- Files written into the Project folder by any Session, including a
  direct-message Session, are ordinary shared files, as they already are in
  Files and Git.
- Search covers metadata and paths only. Searching message text needs its own
  projection and decision.
- Server-authored section headings and notes remain English (a 0214 limit).
- A round's `file` source (0212) still reports a file over 8 MiB as removed;
  that existing quirk is unchanged.
- Unchanged: Task authorization, review evidence pins (0225, 0226), provider
  restrictions, the MCP tool set, and DM isolation.
