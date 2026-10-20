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

This ADR covers the server and the browser; both are implemented in #219.

### 1. Project files are a reference kind

`file` joins the reference kinds under 0214 §7. Its id is a Project-relative,
`/`-separated path. Its revision is the fingerprint work evidence already pins
(SHA-256 of the bytes, or `large:<size>:<mtime>` above 8 MiB), so a file cited
by a message, a round, or a review compares the same way everywhere.

Files are found, resolved, and read only through `WorkspaceService`, under the
Project root:

- An id with a leading `/`, a `\` or NUL, an empty, `.` or `..` component, or a
  `.git` component is never a file; it is not found. Neither is an environment
  file (a component `.env` or `.env.<anything>`, ignoring case), which holds
  secrets; its committed templates (`.env.example`, `.env.sample`,
  `.env.template`) stay readable. Other dot paths (`.gitignore`, `.github/…`,
  dotted configuration) are readable through the context reads and tools when
  named explicitly, as work evidence allows, but are never listed. The state
  directory is outside every Project, so it is never reached.
- Lookup and resolve fingerprint the file through no symlink; a directory, a
  FIFO, or a path through a symlink is not a file. The fingerprint is taken
  from one handle opened without following a final symlink and without
  blocking, checked with `fstat` and to still lie under the Project. A file
  that cannot be opened (no read permission) is unavailable on its own; it
  never fails the other references resolved with it, or the post that cites
  them.
- A read opens the file once, never following a symlink and never blocking on
  a special file, and fingerprints the same descriptor it reads. A file is read
  a page (8 KiB) at a time at every detail, cut on character boundaries. The
  next-page cursor carries the byte offset and a tag of the revision it was
  issued for; a file that changes between pages is reported `changed` with no
  text and no cursor, so two versions are never spliced together, whether the
  new bytes are text or not. A forged cursor is refused. Only a page that
  starts inside a character moves to the next whole one; a file whose first
  byte continues a character is not text. An empty file is one empty section,
  shown at its version.

Search finds files by the words of their path (every word must appear in the
lowercase path), newest first, in a bounded breadth-first walk: at most 5,000
directory entries and 16 levels, never through a symlink, skipping hidden,
generated, non-UTF-8, and Git-ignored entries (one `git check-ignore` per
level) before descending. Each directory is opened once without following a
symlink and listed through that handle. Paths are written to Git on one
thread while its answer is read on another, so neither can block on a full
pipe, and a batch that takes longer than 10 seconds kills Git; Git is always
reaped. A batch Git does not answer (it failed or was stopped) is never read
as "nothing is ignored": that level and everything below it is left out and
the walk reports that it stopped. A nested repository (a submodule, or a
checkout inside the Project, recognised by its `.git`) has its own ignore
rules and is not searched; Git refuses to answer for paths inside a
submodule. In a Project that is not a Git work tree nothing is ignored. It
keeps the 200 most recently modified matches and reports when it stopped. There is no index (0214 §1). A file's time is written
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

The browser has one search (`useWorkspaceSearch` and `WorkspaceSearch`),
hosted by Resources, the Add context dialog, and the titlebar. It always sends
explicit kinds, grouped in sections: Tasks (`research`), findings,
experiments and artifacts, discussions (`import`, `thread`), files, and, only
when chosen, execution history (`session`, `team`, `team_task`, `work`,
`round`). The conversation itself (`channel`) and Session turns are never
results; execution history is the History section, named as the destination
is. A note names the Workspace and, once the server answers, the sections it
reports in `searched` (until then, the sections asked for), says that titles,
summaries, and file paths are matched, and says that message text and direct
messages are never searched. Each section shows its matches ("200+" when cut
short), a cut-short kind is named, and with files on, the walk's skips are
said when they could explain a missing file: nothing was found, or files were
cut short. Searching is debounced (200 ms), a newer search cancels an
older one, and a response for another Workspace, query, or scope is dropped.
A relevant Workspace event only marks the results stale, with Refresh; rows
never reflow under the reader. The titlebar search is its own control ("Search
{Workspace}"), a popover of the top eight results that previews over the
current view and carries its words to Resources; on a phone it is a button
that opens Resources with the search focused, and the command palette has
"Search this Workspace". Session search keeps its name and place.

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
shows no text; its `shown_revision` is the version of the bytes that were
read and found not to be text, from the same handle.

Resolve returns a record's current `title` only when the record is visible in
this Project, including an artifact whose file is gone; never for a missing,
private, or foreign record.

### 4. One preview surface

Every read-only view of a Workspace record is one component, `RecordPreview`
over `useRecordDocument`, on the 0214 content read: the inspector's resource
entry (0228), evidence a Task cites (`EvidenceViewer` is now a wrapper, 0230),
the Add context preview, and the Session composer picker's preview. File
evidence is read through the context reader a page at a time, with the
fingerprint it is pinned with, instead of the editor's file read.

The preview always reads the current version and compares it with the
revision that was cited ("Changed since it was cited"); with nothing cited it
never says that. A reference chip opens its record in the inspector with the
version it cites, so the preview names it ("Cited version: #3f2c1a9") and says
when it changed. The cited version stays in the page: a route names a
resource without its version, and a file is never routable. It never asks for the
pinned revision, because review acceptance (0230 §4) binds to the version the
researcher actually saw, and that must be the one the server checks now.

The preview reports the revision it displayed (`shown_revision`, or the
reference's revision from a server before this ADR), once per revision and
only after a commit that shows content: never while loading, for a failed
read, for a record that is gone, or for a file with no text to show. That
report is what evidence acceptance and "Attach this version" bind to. It
also says when nothing is on screen (on mount while loading, while reading
again, after a failed read or a record found gone), and a host forgets the
reported version then; a host keeps a version only for the record it was
reported for. So "Attach this version" and "Add to message" offer only the
version on screen: never one from before a reload or a failure, from another
result chosen meanwhile, or from before the dialog was closed and reopened. The
preview never changes content under the reader: after a relevant Workspace
event it resolves the record in the background and, if it moved on, says
"This changed after you opened it" with "Show the current version". A file
that changed between pages stops paging and says so. A 404, an unknown kind,
or a record reported removed is "no longer exists".

Resources is a preview-first library: choosing a result opens it in the
inspector (`nav.inspect`, reset, returning focus to the row), beside the list
or as a screen on narrow layouts, and the row stays selected. Focus that
returns to a row goes to the search box with that row active, so the arrow
keys keep working. On a narrow screen the Add context preview replaces the
results; Back returns to them where they were scrolled, with the search box
focused. A Task opens as
its Task, or as its brief while a draft waits for a reference. Going to the
record's home (its Task, its Thread in General, its Session) is an explicit
action inside the preview, through the shared reference mapping; reference
chips keep 0228's mapping. The preview offers no Copy link: the address
already names a routable record, and a file is never routable.

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

The General composer attaches a reference with a revision: the revision the
preview displayed when the researcher previewed it ("Attach this version",
enabled only once the preview is displayed; Ctrl/⌘+Enter), or the current
revision resolved at the moment of attaching when they pressed Enter on a
result (a record that no longer exists is refused). Attaching another version
of a record already cited replaces it; a message cites at most 16 records. A
Task becomes what the message is about (its first reference when sent), not a
second reference, and attaching it never authorizes admission or execution
(0221). A Task attached from a preview or the list is sent at that version
(`GeneralDraft.taskRevision`); a Task that comes from the filter or a reply is
sent without one and pinned when posted. Attaching a different Task replaces
the one the message was about, and says so. A version change is a new message for retries (the draft's signature
includes revisions).

Every reference, in drafts and in messages, is one `ResourceReferenceChip`
over the 0227 `ReferenceChip`: its kind, its title (the server's, then what
the page knows, then a file name or "<Kind> (no title)", never an id), the
cited version in words ("Brief v3", "#3f2c1a9", "v4", "Large file", or none;
never a raw fingerprint), and in words whether it changed since it was cited or
attached, no longer exists, or is not available here (a private Session, which
is never named). A resolver per Workspace batches resolves (at most 32 per
request), caches them per reference and cited revision, forgets what a
relevant event touched (a changed file by its path), and drops answers for a
Workspace that is no longer active. A removed reference cannot be sent: Send
says which one and moves focus to its chip, and the server's 400 stays the
backstop. A changed one is sent at the version that was seen. Revisions are
fingerprints, not snapshots (0214 §2).

Draft references live in the General draft of 0229 (`GeneralDraft.references`,
in the in-memory place memory of 0228 under the General place of its Task
filter), one per record. Earlier Threads are read-only (0229), so General is
the only composer that cites. Finding, previewing, browsing Resources, and
attaching return to the same draft: the Add context dialog keeps its words,
sections, and preview per draft and puts the caret back when it closes;
"Browse in Resources" leaves an attach target (page memory only) that
Resources announces with "Return to message" and "Stop adding", and "Add to
message" in a preview returns to that General view with the composer focused
and the caret where it was. From a preview beside General, the reference is
added in place; on a phone, adding returns to the composer; from Kanban,
Resources, or Members it goes to General's remembered draft ("Add to General
message"); a private conversation and execution history offer no Add.

### 6. What stays private

The search query, the chosen sections, the active result, the results, the
attach target, and the caret live only in page memory. They never go into
routes, stored places, or analytics; a file path never enters a route
(`isRoutableRecordKind` excludes `file`).

## Consequences

- One reader means one set of loading, changed, removed, and unavailable rules
  across Resources, review evidence, and both composers. Evidence files are
  read with the fingerprint they are pinned with, a page at a time, without
  the editor's size limit.
- The Session composer's picker keeps its own list, filters, and keyboard; it
  previews through the one reader and never offers a Project file.
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
