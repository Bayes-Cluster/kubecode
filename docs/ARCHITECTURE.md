# Architecture

Kubecode is a browser application backed by a standalone Rust server. The
active production boundary is defined by ADRs 0161 through 0209.

## Runtime topology

The React client is served at `/` or below a generic configured base path.
`KubecodeApi` derives HTTP, SSE, and WebSocket routes from the current browser
pathname. Health probes remain unprefixed at `/healthz` and `/readyz`.

The same executable can run as an API-only Runtime for native clients. In that
mode it serves discovery plus the versioned API without React assets, requires
one bearer token across client-owned REST, SSE, and WebSocket routes, and
reports its ephemeral loopback port through a machine-readable readiness
document. Provider-owned Team MCP requests use a separate unguessable token in
their internal endpoint because ACP providers do not receive the native
client's bearer. That route bypasses only the outer client bearer middleware;
the Team MCP handler still validates its process-local token and conversation
membership. Browser mode and its external reverse-proxy security model are
unchanged.

The client API includes `GET /api/v1/runtime/status`. Its typed five-field
snapshot combines `AgentRuntime` actor counts and warm-pool policy with the
latest committed SQLite workspace-event cursor and delivery availability. It
is nested below the configured generic base path and, in API-only mode, inside
the existing bearer middleware. The snapshot is operational metadata only: it
contains no Session detail, user content, credentials, filenames, executable
locations, Project paths, or arbitrary server paths.

The Axum server composes eight services:

- `WorkspaceService` registers Project roots, contains filesystem access, and
  owns bounded native Project watchers and their lifecycle.
- `AgentStore` persists Sessions, runs, normalized events, and workspace events.
  It also owns the process-wide `WorkspaceEventBus`, whose latest-value cursor
  wakes live consumers after durable workspace-event commits.
- `AgentRuntime` owns bounded ACP actors for the currently supported Agents:
  Claude Code, Codex, and OpenCode. Tokio owns adapter processes and stdio;
  inactive actors expire after two minutes and the warm inactive pool is capped
  at four, while active prompts are never evicted.
- `AgentCatalog` owns the process-wide, dynamically refreshable CLI and ACP
  adapter readiness snapshot shared by Agent Sessions, Teams, and TUI terminals.
- `TerminalManager` owns reconnectable PTYs independently of browser sockets and
  process-lifetime bounded Composer captures selected from those PTYs.
- `GitService` performs Project- and Session-scoped Git operations without shell
  interpolation. Project status and browser diffs use bounded subprocess reads,
  and Composer diff discovery and resolution retains its independent smaller
  context limits.
- `TeamStore` persists Team authority, membership, tasks, and mailboxes.
- `TeamCoordinator` creates teammate Agent Sessions and applies Team scheduling rules.

SQLite is application metadata, not project content. One server-owned
`Database`, containing one connection and mutex, is shared by
`WorkspaceService`, `AgentStore`, and `TeamStore`. The Agent and Team stores use
that same persistence and transaction boundary directly; there is no Repository
layer between a store and SQLite. The connection uses rollback journaling with
immediate write transactions. A process owner lock rejects a second Kubecode
server for the same state database. Project files remain on disk at their
original absolute paths.

## Source boundaries

The server source tree follows the service boundaries. `server/src/api/`
contains Axum route composition and request handlers. `server/src/agent_runtime/`
contains the actor pool, ACP adapter launch, dispatch, event journal, and
interactive request handling; `AgentRuntime` is the sole owner of ACP actors and
their provider subprocess lifecycle. Conversation interaction contracts —
prompt queue, optimistic send with client message ids, typed terminal causes,
boundary fork, subagent visibility, and the per-agent adapter seam — are
defined in [ADR 0210](adr/0210-agent-interaction-model.md). Fork, branch, and revise share
one boundary primitive (`AgentStore::resolve_turn_boundary`): it resolves the
cut points around a target run and rejects an open turn with a typed 409
(`fork_unavailable`) instead of clipping silently. Provider-native fork is
preferred whenever the agent advertises the capability — the child keeps a
linked provider session (no `context_prefix` round trip); otherwise the child
rebuilds from the transcript prefix. The child records its lineage (boundary
run and the path taken) for navigation and debugging. Adapter-translated
subagent activity routes into sub-conversations that activate the dormant
`ConversationRelationship::Subagent` (persisted, excluded from sidebar
listings) and broadcast the agent-agnostic `subagent_update` envelope —
`{sessionId, name, prompt, status}` — on the parent stream; attribution is by
sub-session id, so early chunks land before a late registration and the name
backfills. Tool-call persistence coalesces non-terminal updates by tool id into one
row (flushed at terminal status), and raw input/output yield to structured
content in persisted payloads. Transient conversation state (streaming flag, pending
permission/elicitation wait, with its deadline when the server enforces one)
broadcasts as whole-snapshot
`conversation_state` frames on the same stream — at subscription-adjacent
transitions, on boot recovery, and whenever a wait resolves — so any client
converges from cursor + snapshots alone; a cleared wait publishes
`"pending": null`. Only an input (elicitation) request times out, after
`KUBECODE_PENDING_REQUEST_TIMEOUT_MS` (default five minutes); a permission
request waits until it is answered or its turn stops, so it reports no
deadline (ADR 0232). Terminal output
is additionally appended to durable per-terminal logs under
`WorkspaceService`-managed state paths (strictly validated terminal ids, no
path traversal); reads prefer the live ring and fall back to the durable
transcript after restart, with graceful truncation of corrupt or oversized
tails. `server/src/agent_store/` and
`server/src/team_store/` group persistence operations by feature while retaining
a shared transaction pattern. The WeChat iLink channel (ADR 0211) is a
transport adapter owned by `ILinkService` in `AppState`; a `ChannelBridge`
started alongside it routes inbound WeChat messages through existing run
admission and derives outbound replies from the same workspace event stream
the browser consumes. Runtime shutdown stops the bridge (typing cancelled while
credentials still work) before the service aborts its long polls.
one `AgentStore` and one `TeamStore`. `server/src/agents.rs` and
`server/src/teams.rs` are public compatibility re-export shims, not competing
store implementations.

Research questions (ADR 0212) are a third feature store on the same SQLite
owner. `server/src/research_store/` owns the domain — questions, immutable
brief revisions, the attributed entry log, Session/Team associations,
rounds, and findings with their publications — and `server/src/research_api/`
exposes it under
`/api/v1/projects/{project_id}/research`, composed through `AppState`. The store
commits its `research_updated` workspace event in the same transaction as each
change. It never starts an Agent; execution continues to flow through the Team
and run-admission paths. The one cross-store write is deliberate: completing a
Team linked to a question records a pending research outcome inside the Team's
own completion transaction, so the hand-off cannot be lost or repeated.

Durable research experiments (ADR 0213) are a fourth feature store on the same
SQLite owner. `server/src/experiment_store/` owns the execution envelope a
researcher approves per round, the launch attempts admitted under it, the waits
members register, and the committed observations that resolve them;
`server/src/research_api/execution.rs` exposes read and control routes. Team
transitions consult these tables in their own transactions: completion is
blocked while an experiment is active, an analysis is pending, or a wait is
open, and a turn that ends with a registered wait is not a missing report.

Project context discovery (ADR 0214) is a read-only service, not a store.
`server/src/project_context/` composes the research, Session, Team, and
experiment stores and `WorkspaceService` in `AppState` and answers `search`,
`read`, and `resolve` over typed references (`research`, `round`, `finding`,
`session`, `session_turn`, `team`, `team_task`, `import`, `experiment`,
`artifact`, `work`, `thread`, `channel`, and `file`). It
keeps no data and no index, so an answer can never drift from its owner; every
call takes the Project first and treats another Project's record as missing.
`server/src/context_api/` exposes it under
`/api/v1/projects/{project_id}/context/{search,read,resolve}`. Reads are
bounded (summaries of 280 characters, sections of 8 KiB, page cap of 50, a
200-candidate scan per owner), progressive
(`summary` → `content` → `evidence`), and passive: they never start an Agent,
assign work, approve a brief, or grant execution. A search page names its scope
(ADR 0231 §2): `searched` (the kinds covered; an empty request covers every
kind but `file`), `truncated_kinds` (the kinds a cap or budget cut short, with
`truncated` true exactly when it is not empty), and `counts` (matches per kind
before paging). Artifacts and files on a returned page get a metadata-only
existence check, so a removed one is listed as removed. Artifacts are read as bounded
UTF-8 text through `WorkspaceService::read_execution_text` under the execution
root of the Team that ran the experiment, with no symlink traversal. Project
files (ADR 0231 §1) are a `file` reference whose id is a Project-relative path
(never through `.git` or a symlink, and never an `.env` file) and whose
revision is the fingerprint work evidence pins, taken from one handle opened
without following a symlink or blocking. They are searched only when the kind
is named, by `WorkspaceService::search_project_files` (a breadth-first walk
bounded at 5,000 entries and 16 levels that lists each directory through a
handle opened without following a symlink, skips hidden, generated, and
Git-ignored entries and nested repositories, and keeps the 200 newest path
matches). `git check-ignore` is fed and drained on separate threads under a
10-second limit that kills and reaps Git; a level Git does not answer for is
left out and reported as cut short, never treated as nothing ignored. Files
are read a page at a time by
`WorkspaceService::read_text_page` with a cursor bound to the file's revision,
so a file that changes between pages is reported changed instead of spliced.
A read names `shown_revision`, the revision whose content it shows (the pinned
brief, the bytes of a page); `resolve` returns a record's `title` only when the
record is visible in the Project, never for a missing, private, or foreign one.
`AgentStore::read_turn_text` gives cross-Session turn reads a bounded view of
the canonical event log without copying it.

Agents reach the same reader through `server/src/context_mcp.rs`, a read-only
`kubecode-context` MCP server advertised to **every** Session next to the Team
server (HTTP at `/api/v1/context-mcp/{token}/{conversation_id}`, authorized by
a credential derived per server and per conversation from the process secret, so
the read-only credential every Session holds cannot open the Team server or
another conversation's route). It has four passive tools — `context_round`,
`context_search`, `context_read`, `context_resolve` — and the caller's Project
is derived from its Session, never from an argument. Hidden revision snapshots
and unknown conversations get no tools. Each conversation also has its own MCP
session manager, so an `mcp-session-id` issued to one conversation is unknown
to every other conversation's URL. `context_round` binds the caller's *current
run* to its round (a Solo round's prompt is admitted as `research:{round_id}`),
so a later round queued on the same Session never replaces the one being worked. A Team member whose Agent cannot reach
an HTTP MCP URL receives the server in-process as before; a Solo Session on such
an Agent has no context tools and relies on the round prompt. Solo and Team
rounds share one delivery: `team_mcp::round_delivery` builds the pinned brief
revision, the instruction, the selected sources with their current availability,
bounded earlier rounds, attributed findings, and execution facts, and is served
both by `team_get_context` and by `context_round`. A later brief edit never
changes a running round's direction; the delivery reports `stale` instead.

The Session Composer reaches the same reader through a `project_context`
Composer kind (`composer_catalog.rs`, `api/composer.rs`, the preflight in
`agent_runtime/dispatch.rs`): the picker in `ComposerProjectWorkPicker` searches
and previews through `/context/search` and `/context/read`, and registration,
validation, and dispatch re-resolve the typed reference server-side, so the
browser never supplies authority or content It
does not accept a `file` Project reference: a Session composer cites files
under its own execution root.

Imported discussion (ADR 0214 §8) lives in `research_store/imports.rs` and is
exposed by `research_api/imports.rs`: immutable, attributed source material per
question with deterministic candidate extraction, a revision-checked path into
the brief (`import_id` on the brief edit), `import` as a round source and as a
context reference kind, and a bounded, previewable discussion packet. Importing
and exporting never start work.

Workspace-owned research work (ADR 0215) is a sixth feature store on the same
SQLite owner. `server/src/work_store/` owns work items (the canonical task),
attempts, assignments, result references, and each round's fenced coordinator,
all scoped by Project (the Workspace). Legacy Team tasks are mirrored into it
with their ids: triggers on the Team tables queue the owning Team in the same
transaction as the legacy write, and `WorkStore::reconcile` applies the queue
before any work read or write and at startup, so the mirror is resumable and
never stale to a reader. The Team store stays the only writer of legacy items;
native items are changed only through the work store's revision-checked,
coordinator-fenced commands (authority is re-read inside each command's
transaction; a handoff increments the round's epoch). Deleting a Team mirrors
its last changes and re-owns its work as native in the same transaction, so
work, attempts, and results outlive the Team. Each command commits a
content-free `work_updated` workspace event, and every item carries a
state revision so a stale card is refused rather than applied.

The Workspace conversation (ADR 0216) is a seventh feature store,
`server/src/channel_store/`, with routes in `server/src/channel_api.rs`. A
Project has one default channel (created on first read); messages are
immutable, attributed, sequenced per channel, and idempotent per client message
id; a Thread is rooted at a top-level message and can be linked, revision-
checked, to a research question without moving any message. A message may
carry an intent (`ask`, `request`) that a consumer claims exactly once by
message id. References and mentions are validated against the same Project.
Each write commits a content-free `channel_updated` event. `ProjectContext`
reads `thread`, `channel`, and `work` sources, bounded and attributed, so an
agent handed one Thread sees that topic and not the rest of the channel. The
browser surface is `src/kubecode/channel/`: the navigator entry sits above the
research list, the main pane swaps to `ChannelWorkspace` (timeline, composer,
Thread pane), and feeds converge on `channel_updated` events by sequence
number.

Orchestrated execution (ADR 0217) adds three server-side pieces. The
orchestrator (`server/src/orchestrator/`) owns durable `message_routes`: it
turns unclaimed `ask`/`request` intents into routes (requests only to the
coordinator of an admitted round, otherwise answered with a note), leases and
delivers them under a runtime-de-duplicated delivery key with bounded retry, and
resolves a coordinator route to the round's *current* holder at delivery. A
background loop in `AppState::start_orchestrator` runs it on a short interval
and immediately when a message with an intent is saved. The work store holds
`round_policies` (executors, parallel attempts, total attempts, pause) that only
the researcher sets and that `assign`/`begin_attempt` enforce in their own
transactions. `WorkAgent` (`server/src/work_agent/`) is the caller-bound command
service, exposed to every Session as the `kubecode-work` MCP server
(`server/src/work_mcp/`) with a per-server, per-conversation credential;
`orchestrator_api` lets the researcher read and set limits and list routes.

The Workspace work board (ADR 0218) is one server-composed projection,
`server/src/work_api.rs`: `GET .../work/board` (cards, per-stage and
per-condition counts, a closed lane, filters by question, round, Team, Agent,
Thread, condition, and source), `GET .../work/{id}` for the inspector, `POST
.../work` to add a task, and `POST .../work/{id}/commands` for the researcher's
revision-checked commands (state revision, plus the plan revision where the
store needs it). The browser surface is `src/kubecode/work/`: `WorkBoard`
(columns, attention strip, closed lane, drag-to-command), `WorkInspector`, and
`useWorkBoard`, which refetches on `work_updated` and `orchestration_updated`.
The Team view's task tab renders the same board under a Team scope and keeps
the Team's own dialog for Team-owned tasks.

Experiments, analysis, and evidence on native work (ADR 0219): an experiment may
carry a native task id and no Team (`experiment_store` admits it only for active
native work of the same round). `orchestrator/analysis.rs` routes each finished
task-owned experiment to the executor once and moves the task to `analyzing`;
`work_agent/analysis.rs` holds `launch_experiment`, `decide`, `request_decision`,
`brief`, and `repin`, exposed as `work_launch_experiment`, `work_decide`,
`work_request_decision`, `work_brief`, and `work_repin`. `work_agent/evidence.rs`
compares each cited reference's pinned revision with its current one; acceptance
(`WorkAgent::review` and the researcher's `review` command) refuses stale
evidence with `409 work_evidence_stale`. `work_store/decisions.rs` holds
`decision_requests` (answered at `POST .../work/{id}/decisions/{request}/answer`)
and the server-owned analysis/attention transitions. Reviews are published to
the Thread and the question's log by `Orchestrator::publish_review`. A dispatch
route is held (not failed, no attempt used) while its task or round is paused
or blocked, and a dispatch that fails for good closes its never-started attempt
and tells the coordinator, so the task can be started again. A coordinator may
answer the request that was routed to a round it holds now; the answer's Thread
is linked to that round. Files over the hashing limit are fingerprinted by size
and modification time. The inspector opens an experiment (output tail,
artifacts), an artifact, a cited file, or any ProjectContext record in place
through the one record reader (`src/kubecode/resources/RecordPreview.tsx` over
`useRecordDocument`, ADR 0231 §4; `work/EvidenceViewer.tsx` wraps it), marking
a record that changed or vanished since it was cited.

Workspace members (ADR 0220): `server/src/member_store/` owns the roster — one
General Agent per Workspace (a partial unique index plus an idempotent
`ensure_general`, run at project creation and on the first roster read of an
older Workspace) and specialists, each with a public Session and, later, a
separate DM Session, plus a `member_sessions` history that keeps old Sessions
attributed but without authority. Defaults are server state
(`member_defaults`, revision-checked). Authority is enforced in services: the
`AssignmentGuard` refuses the manager's and any DM Session's assignment in
`WorkStore::assign` and refuses any Session but the General Agent's current one
(or a non-member legacy Session) coordination in `assume_coordinator` /
`handoff_coordinator` / round start; `WorkAgent` refuses every Session the
manager has ever had the executor commands (`launch_experiment`, `decide`,
`report`, `create_executor`), failing closed if the roster cannot be read;
and assignment goes to a specialist member's
current public Session (`work_members`, `work_assign` with a `member`).
Replacing a member's Session (`POST .../members/{id}/session`, optionally with
a new provider) is one transaction that refuses a member with open work and
hands the old Session's rounds to the new one; a member's Session cannot be
deleted through the Session API. `RuntimeSink` gives a member's Session its configuration values and
role brief once per specification revision. `member_api.rs` serves the roster
and defaults; the browser surface is `src/kubecode/members/` (`MemberRoster`,
`MemberDefaultsPanel`). The Members destination keeps the current roster and the
defaults for new members on separate tabs; Settings > Agent defaults holds only
the defaults and links to the selected Workspace's Members. A saved default never
rewrites an existing member. A member row and profile show role, setup state and
actions, with execution (from the member Session's latest run) apart from
membership; the project manager's fixed responsibility and its locked
full-access mode (ADR 0237) are shown locked, and a `mode` option is refused in its
defaults before saving. When the manager is missing or needs setup, General
shows `ManagerSetupNotice` (retry in place, or open the manager in Members).

Tasks (ADR 0221): `server/src/task_store/` adds to the research, work, and
member stores only the records of the researcher's authorization
(`task_authorizations`: admit, execute, revise), the researcher's reviews
(`task_review_requests`, `task_reviews`), and an append-only `task_events` log
that decides the stage (ready, in progress, review, done). A Task's identity is
its research question's id; the card is a read model (`TaskStore::card` /
`board`) over the brief, rounds, internal work, decision requests, and roster.
The General Agent proposes (`task_propose`, `task_revise`, `task_show` to show one
again), and, given the id of the researcher's own message, admits (`task_admit`), approves a revised brief,
starts execution (`task_start`: a round pinned to the approved revision with
the manager as coordinator, no limit or envelope set), and asks for review
(`task_request_review`). `check_instruction` verifies in the service that the
message is the researcher's, unquoted, in General, used once across every step,
newer than the Task's last stage change, and that the General Agent's top-level
proposal of exactly that brief revision (key `proposal:{id}:{revision}`)
preceded it and is the one the instruction names or the latest shown (the
channel's gapless sequence is the clock); proposing and revising post the
proposal to General, so only something the researcher was shown can be
authorized. The manager coordinates many Tasks, so a Task round's Session is
set without the exclusive research link (`round_set_shared_session`). `task_api.rs` serves
`GET .../tasks/board`, `.../drafts`, `.../{id}` and the researcher's
`POST .../review` (refused with `409 work_evidence_stale` while evidence the
Task's work or its open review request cites has changed) and `.../repin`
(by `work_id` or by `request_id`, bound to the looked-at `revision`); it has no
admission endpoint. A review request pins each `kind:id` it cites
(`task_review_requests.evidence_pins_json`). Recording a decision creates a
`task_review` route to the General Agent's public Session (ADR 0226).
A question whose round the researcher already started is admitted with
`legacy_round` origin; nothing else is admitted retroactively.

Task lifecycle and read model (ADR 0230): every stage read filters
`task_events` on one `STAGE_EVENT_KINDS` list, so the `archived`/`restored`
events that `TaskStore::set_archived` logs never move a stage. The instruction
watermark (`WATERMARK_EVENT_KINDS`) is the stage events plus `restored`, so
nothing said before a Task was archived starts it after it is restored; a
retried instruction whose execute record has no round yet is checked against
the stage and watermark like a new one. `POST …/tasks/{id}/archive|restore`
(204) and the research `archive|restore` routes share one rule: archiving is
refused with `409 task_active` (`reason`: `under_review`, `work_active`) while
a review is open or any of the question's internal work is active (in any
stage), both checked inside the archiving transaction (request_review checks
the flag inside its own). An archived Task refuses admission, approval,
execution, review requests and new internal work (`WorkStore::create`).
`research/{id}/resolve|reopen` answer `409 task_owned` for an admitted Task;
its research status is written only by the Task service, in the same
transaction as the review or start of execution that implies it. Every
researcher re-pin of a Task's evidence names the looked-at `revision` — on
`…/tasks/{id}/repin` and on the work board's `repin` command for a Task's
internal work (`400` without it, `409 work_evidence_stale` when it moved on) —
and the coordinator's `work_repin` refuses a Task's evidence, leaving it
flagged. A research detail carries `task_stage` (null unless admitted) and a
work card's `research` carries `task`. The read model adds `TaskCard.last_event`,
`Draft.shown_message_id`, `TaskBoard.archived`, and on the detail `archived`,
`evidence` (one row per cited `kind:id` with every pin, status and title, at
most 64, titled through `Evidence::describe`/`ProjectContext::item`),
`timeline` (events, approvals and brief revisions with the General message
that carried each, at most 100), `pending` (keys `review:`, `question:` — open
work only, as the card counts —, `suggestion:` for a suggested change of
direction not yet decided, `brief:`, `evidence:`), `actions`,
`authorizing_message.task_id`, `general_message_id` on review requests and
verdicts (also on the `POST …/review` response), and `internal_work`
`conversation_id`/`updated_at`. The archived list is cut to the newest 50
before stages and outcomes are read. Message ids come from batched, read-only
`ChannelStore` lookups (`messages_by_client_ids`, `proposal_messages`,
`messages_by_ids`) over the existing client-id index. `stale_evidence` is kept,
deprecated. `ResolvedRef` carries the record's `title`.

Pending decisions and delivery state (ADR 0232): `server/src/attention/` is one
read model of what waits on the researcher. `collect` reads the workspace event
cursor first, then the runtime's pending permission and input maps
(`AgentRuntime::pending_requests`, never tool input; a Team leader's request
counts once escalated, and escalation now updates the waiting entry), open
questions on work inside a Task (`WorkStore::open_decisions`), open review
requests, undecided suggestions (`ResearchStore::open_proposals`), every
admitted Task's brief revised past its approved revision
(`TaskStore::awaiting_briefs`, the rule `TaskStore::pending` shares through
`brief_awaiting`, with the General message when one showed it), proposals the
General Agent showed that are not on the board yet
(`TaskStore::awaiting_proposals` over `ChannelStore::proposal_showings`),
members needing setup, active runs, member Sessions' latest failed turn, queued
prompts and failed researcher-originated routes; the pure `project` keys each
decision (`permission:`, `input:`, `question:<request>`, `review:`,
`suggestion:<entry>`, `brief:<task>:<revision>`, `proposal:<task>:<revision>`,
`setup:`, the keys the Task detail's `pending` uses too) so it appears once,
orders and caps the list, and reports a failing source in `incomplete`. Only
input requests carry `deadline_ms`; a permission request has none, because the
runtime never times it out. `attention_api.rs` serves
`GET …/projects/{p}/attention` and `GET …/attention/summary`; decisions are
still answered on their own endpoints. `orchestrator/delivery.rs` projects each
researcher message from its routing mark (`routing` pending, done or `denied`,
with `routing_issue` and `reroutes`), its routes, and the recipient Session's
admission of `route:<route>:<recipient>` (started, queued, withdrawn):
`GET …/deliveries?message_ids=`, a `deliveries` map on message pages,
`POST …/routes/{id}/retry` (same route id, researcher kinds only, at most three
times with the limit inside the conditional `UPDATE`; `route_target_gone`,
`route_needs_setup` without using a retry, `route_unavailable`, and
`route_superseded` for a review verdict that is no longer its Task's last step
or whose Task is archived, which `RouteDelivery.superseded` also reports) and
`POST …/messages/{m}/reroute` (only for `manager_unavailable` and
`member_unavailable`; `Denial.reroutable` follows the code). Failure and denial notes are keyed
per retry or reroute and a note already written never aborts a pass. The DM
send reports `admission`, `…/dm/pending` lists queued direct messages, and the
Task detail adds `execution` (the round's pause policy) and `delivery_issues`.

Attention in the browser (ADR 0232): `attention/useAttention.ts` keeps one
snapshot of `GET …/attention` per Workspace, refetched (250 ms debounce) on the
events that can change it — Task, research, work, member, channel and
orchestration updates, permission and input requests and answers, run start
and completion, and `conversation_state` that carries `pending` — and after a
reconnect; a response older than the newest applied one, by request ticket or
by cursor, is dropped, and a failed read keeps the last snapshot. The shell
provides it through `AttentionContext`; `markResolving(key, call)` runs an
answer and keeps the key busy until a snapshot requested after the call omits
it (10 s fallback), so Needs you, the bell, the Task panel, the strip and the
Session prompt resolve together and nothing is removed locally.
`attention/attentionTargets.ts` turns items into `NeedsYouEntry` (title, badge,
detail, group, and a target with a `focus` key: `question:`/`review:` on the
Task inspector, whose tab the shell sets first, `suggestion:` in its Results and
`brief:` in its Overview; `message:` for a proposal, or a revised brief General
showed, in General; `permission:`/`input:` in General's or the DM's Working-now strip, or
the Session itself; `member-setup:` on Members). The titlebar bell counts this
Workspace's entries and the others' from `GET …/attention/summary`
(`useAttentionSummary`, 1 s debounce); a notification click opens the waiting
item of that Session when there is one; past five entries the bell offers all of
them in Needs you. An input request in a member's DM is titled there by who
asks, never by what. `useNeedsYouAnnouncement` feeds the shell's always-mounted
status region with what newly waits and what was resolved. `PermissionPrompt` and
`ElicitationPrompt` are shared by `SessionComposer` and
`attention/ExecutionStrip.tsx`, which lists `executions` for a scope (General's
members, one DM, or a Task without prompts) grouped by Task (ADR 0238): one
`StopButton` per Task ("Stop {task}": pause the Task's round policy, then
`DELETE /runs/{id}` for each of its turns) or per reply tied to no Task, busy
until its turns leave the snapshot and announced when done or failed. One entry
is a compact row; more fold into a "{count} running" Popover. The scope's member
prompts (busy while their key is resolving) are never folded and are capped and
scroll under 720 px, and failed turns show "Open {name} in Members" until
dismissed (place memory). The composers of General and the DM offer no Stop.
General and the DM render messages with the AI Elements `Message` composition
and dock the execution strip, the outbox rows and the Prompt Input card (reply
and references, the shared `Composer`, and only actionable states)
at the foot of the view (#232, ADR 0233 §7); the thread takes the middle three
quarters of the pane, the dock is centered and half of it within 480–960 px,
with the running strip, its list and the card at one width, each running item
an `attention/ExecutionRow.tsx` (ADR 0240), and the researcher's messages sit
on the right (ADR 0239); `MessageList` keeps its own
scroller for older messages and the reading position.
`attention/useMessageDeliveries.ts` reads `GET …/deliveries` for the
researcher's top-level messages on screen, again on `orchestration_updated`
naming one of them (or `channel_updated` while one is saved or sending), and
runs Retry (`POST …/routes/{id}/retry`) and Try again (`POST …/reroute`) once
each in flight, telling a refusal from a request that failed and dropping a
"needs setup" refusal when a member changes; `foldRoutingNotes` removes the notes a loaded delivery names
from the timeline and keeps their text for its Details. `dm/useDmPending.ts`
reads `…/dm/pending` so a message queued behind a running reply stays visible.
`tasks/TaskWork.tsx` adds `RoundPauseControl` ("Pause new work on {task}",
`PUT …/rounds/{r}/execution-policy` with the shown revision, never re-sent on a
conflict), the Task's waiting line with Show, its Working-now rows, and its
`delivery_issues` with Retry.

Task board and details (ADRs 0225, 0230): `tasks/useTaskBoard.ts` and
`tasks/useTaskDetail.ts` read `GET …/tasks/board`, `…/tasks/drafts`, and
`…/tasks/{id}` and refresh on `task_updated`, `research_updated`, `work_updated`,
and `orchestration_updated` events and after a reconnect. The pure
`tasks/taskLifecycle.ts` (next step, required action, condition tone, default
section, progress, the board's first stage) and `tasks/taskReview.ts` (whether a
changed record may be accepted at the displayed version, what blocks an
acceptance, which pins move) are the rules every Task surface shares.
`tasks/TaskBoardView.tsx` is the Kanban entry: proposals above the four stages,
archived Tasks below, single-button cards (`TaskCardView`, `TaskStatusBadges`),
a Needs-you filter, and — under a 640px container query — one stage at a time
that follows the Task inspected last; its stage, filter and scroll are place
memory. `tasks/TaskPanel.tsx` is the Task entry of the inspector stack: one
header with the Task's badges, Discuss in General and More actions (archive or
restore through `POST …/archive|restore`, refusals shown with their reason), a
next-step line, and Overview (`TaskOverview`, `TaskQuestions`), Results
(`TaskResults`) and Activity (`TaskActivity`) tabs; it reads the research
bundle only when a section needs it, and its tab, feedback, outcome and answer
drafts are kept under `placeKey.task`. `work/EvidencePanel.tsx` shows a cited
record with `work/EvidenceViewer.tsx` (a wrapper over the one record reader,
which reads the current version — files too, through the context reader — and
compares it with the cited one), which reports a display (`onDisplayed`,
with the read's `shown_revision`) only after the cited record itself rendered —
never while loading, on a failure, for a removed record, a related record
(handed to the stack as a `resource` entry through `onFollow`) or a failed
"Load more" — and the panel records it in the stack's `InspectionRecord`.
`TaskResults` enables "Accept the version you saw" only while that revision is
the current one, re-pins every pin of the record at it through `…/repin`,
reloads the Task once when the displayed version is newer than the list (a pin
that fails after an earlier one moved says only part was accepted), and
decides through `POST …/review`, holding the other decision while one is
recorded; its status links to the verdict in General, or says the decision was
recorded but could not be posted when no verdict message is known.
Going to General from a Task (`tasks/taskNavigation.ts`) keeps the Task beside
General and replaces it over a narrow view. A legacy question that is a Task
(its research detail's `task_stage`) shows its stage and links to it, without
resolve/reopen/archive (`ResearchWorkspace` `onOpenTask`), and a refused
research command is shown in the catalog's words. The work inspector sends a
Task's changed evidence to the Task's Results instead of offering its re-pin. `MessageItem`
renders proposal messages and Task chips. The browser acceptance
(`tests/smoke/research-workspace.spec.ts`, `tests/smoke/task-review.spec.ts`)
uses `tests/smoke/agents.ts`: the fixture provider records each Session's MCP
servers and prompts under `.local/playwright-fixtures-<port>`, and the test acts
as a member through that Session's own MCP endpoint. The service-level
counterpart is `server/tests/workspace_blueprint_acceptance.rs`.

Workspace shell (ADRs 0224, 0228 and 0234): `app/WorkbenchShell.tsx` owns the active
Project; where the researcher is in each Workspace is a location kept by the
pure reducer in `app/location/workspaceLocation.ts` (a place — General with an
optional message, Task filter and Thread, Kanban, Resources, Needs you, Members, a private
conversation, execution history with its Session, or a legacy question — plus an
inspector stack of ids), remembered per Workspace and per view and stored by
`useWorkspaceLocation` in `kubecode:workspace-location:v1` as formatted routes
that the strict parser validates on read. A Workspace with no remembered place
opens General; nothing falls back to the Sessions surface, which opens only
through `openSession` (a Session row or search result, New session, a Session
reference, a permission entry, a notification, or a link). Startup picks a
link's Project, then the last one used, then the first (`pickInitialWorkspace`).
`app/location/locationRoute.ts` maps locations to `WorkspaceRoute`s and back;
`app/workspaceRoute.ts` parses strictly and formats ids and view names only,
with deeper inspector entries as repeated `inspect=` tokens and file evidence
never written. `useWorkspaceRouteSync` mirrors the route into the URL hash,
reports a link still being reached as `pending` (the main pane shows "Opening
Workspace…", never a Session), abandons a link to an unknown Project at once,
and replaces the history entry for quiet changes. `app/ProjectNavigator.tsx` is
the Workspaces navigation: `app/WorkspaceList.tsx` (one row per Project), then
`app/WorkspaceNav.tsx` (the five destinations General, Kanban, Resources, Needs
you — a count; the list is the `attention/NeedsYouView.tsx` destination over
`NeedsYouEntry` from `location/needsYou.ts`, hosting no inspector — and
Members, then the roster with private-message shortcuts and Direct messages
under their own headings), then a collapsed History and execution section with the
Session search across all Workspaces, this Workspace's Sessions and Teams,
Threads and questions. Reference chips in General and rows in Resources open
through the shell's one `openReference` (`location/references.ts`): a Task or a
record in the inspector of the view they were chosen in, a Thread in General
with nothing over it, a work item on Kanban with its Task, and a Session as
execution history. The inspector (`app/inspector/`) is one stack per
inspector-hosting view (General, Kanban, Resources, Members, a private
conversation; every destination is titled by `app/DestinationHeader.tsx`): `InspectorPane` renders each entry through `INSPECTOR_PANELS`
(`tasks/TaskPanel.tsx`, `members/MemberPanel.tsx`, `work/EvidencePanel.tsx`,
`resources/ResourcePanel.tsx`) with the Back and Close the shell computes, keeps
lower entries mounted under `visibility: hidden` and `inert`, and is shown beside
the view as the 360-pixel `--ws-panel-inspector` column or over it by the width
of the row (`useInspectorPresentation`, a
container rule; the navigation overlay keeps its 980px viewport rule). Slices
move the researcher through `location/WorkspaceNavigation.ts` and never import
the shell. `location/placeMemory.ts` keeps what a place holds besides its address
for the life of the page and never on disk: drafts and reply targets
(`usePlaceState`, `usePlaceRef`, keyed by `placeKey`), list scroll positions
(`useScrollMemory`, `data-scroll-anchor`), and focus return (`data-focus-key`);
General's reading position is reported by `MessageList` and folded into its
place when General is left, and written onto General's own history entry before
the next place is pushed, so Back lands on it. Workspace search, previews, and
references (ADR 0231) live in `src/kubecode/resources/`: one search core
(`useWorkspaceSearch`, `WorkspaceSearch`, explicit sections from
`searchScope.ts`, its words, sections, active row and results kept in place
memory only) hosted by `ResourcesView` (a preview-first library whose rows
open `ResourcePanel` in the inspector beside the list, never leaving it), the
General composer's `AddContextDialog` (results beside the one `RecordPreview`;
"Attach this version" or Enter for the current version), and the titlebar's
`WorkspaceSearchLauncher` (the shell's `searchSlot`; a button to Resources on a
phone; the palette's "Search this Workspace"). `attachTarget.ts` decides which
General draft a reference found elsewhere joins and returns there;
`draftReferences.ts` keeps one versioned reference per record in
`GeneralDraft.references`. `ReferenceResolverProvider` (mounted by the shell
per Workspace) batches resolves for every `ResourceReferenceChip` — in drafts
and in messages — so chips are named, versioned, and say when they changed or
are gone, and the composer refuses to send a removed one. The Session
composer's `ComposerProjectWorkPicker` previews through the same reader and
never offers a file. A route can name a message, read by id
(`GET …/channels/{c}/messages/{id}`) and landed on after a page is loaded around
it.

General routing and direct messages (ADR 0223): `channel_store` marks a
researcher's plain top-level remark, or an agent message that names someone, as
pending and stores the Task it is about (`task_id`, from its research
reference), an optional `reply_to`, and a hand-off depth (`hops`, bounded by
`MAX_HANDOFF_HOPS`). `Orchestrator::route_conversation` reads each pending
message once (routes first, then mark read) and writes `discussion` (to the
General Agent), `mention`, or `agent_handoff` routes to members' *public*
Sessions; `next_hops` derives a hand-off's depth from what was routed to the
speaker within the hour. Members speak in General with the `general_post`
tool (`WorkAgent::general_post`, public Sessions only). `GET …/messages?task_id=`
filters the same records. `dm_api.rs` serves the researcher's private
conversation with a member: `POST …/members/{id}/dm` (opens the DM Session),
`…/dm/turns`, `…/dm/messages` (through `RuntimeSink`, so the Session is
configured and briefed), and `…/dm/share/preview` + `…/dm/share` (the exact
text, confirmed by digest, posted as the researcher's own message).
`ProjectContext::with_members` hides every DM Session from search, resolve, and
read; `channel_api` refuses mentions and citations of one. A researcher's
General or Thread message and a DM share pin their references first
(`channel_api::pin_references` over `ProjectContext::pin`, ADR 0231 §5): a
reference without a revision gets the current one, a supplied revision is kept,
a removed record is refused with a 400, and a retried client message id replays
the stored message before anything is resolved again. Agent posts are
unchanged. The browser surface
is `src/kubecode/dm/` (`DmPane`, `DmShareDialog`) beside the channel's task
filter, citations, and collapsed routing notes.

Member identity and member-following routes (ADR 0229): every conversation
message the API serves (`GET`/`POST …/channels/{c}/messages`, one message by
id, and the `…/dm/share` response) is a `MessageView` — the stored `Message`
plus `author_member_id` and `mention_member_ids`, resolved at read time through
`MemberStore::public_authors` (every public Session a member of the Project has
had, current or ended; never a DM Session). Nothing is stored or migrated, and
the projection grants nothing. A failed roster lookup degrades to no member ids
(logged), so identity never fails a read and never names the wrong member.
`POST …/messages` accepts `mentions: [{member_id}]` beside the legacy
`[{session_id}]`: a member resolves to its current public Session when the
message is written, or the post is refused with 400 `mention_unavailable`
(`reason`: `removed`, `needs_setup`, `not_found`); a retry with the same client
message id reuses the Session the stored message named that member by
(`ChannelStore::by_client_message_id`), so it replays after a Session
replacement. The Orchestrator re-resolves a conversation route (`discussion`,
`mention`, `agent_handoff`, `task_review`; `RouteKind::follows_member`) at
delivery when its target is a member's ended public Session: to the member's
current public Session, failed with a note if the member was removed, retried
then failed with a note if it needs setup. `message_routes.recipient` records
the Session actually reached and `next_hops` counts depth through it. A
researcher message that reaches the General member is framed for discussion and
admission even when the manager is @-named, and every frame quotes the
replied-to message fenced. `general_recent` reports `reply_to` and `to` (named
members' handles through public Sessions only). The `ask`/`request` intents and
Thread routes stay accepted for older pages.

In the browser, `WorkbenchShell` reads the roster with removed members
(`useMembers(…, { includeRemoved: true })`) into one `MemberDirectory`
(`members/memberDirectory.ts`: by id, by current public Session for messages
read without the projection, the live members with the manager first) and
provides it through `MemberDirectoryContext`; views name people with
`members/memberIdentity.ts` (`memberView`, `authorView`, `messageRecipients`,
never "Agent") drawn by `members/Identity.tsx`, whose live-member name opens the
profile through `useWorkspaceNavigation().inspect`. General's rules are pure
modules under `channel/`: `generalDraft.ts` (one `GeneralDraft` of text, reply,
Task, references, last attempt, and last failure; recipients read from the
text outside quotes and code, removed members included, and unknown until the
directory is ready; `sendBlockedReason`; `withReply`; `toNewMessage` with `{member_id}` mentions and the
Task as the first research reference), `timeline.ts` (days, author groups,
collapsed routine notes, denial notes attached to their message or shown on
their own, never collapsed),
`delivery.ts` (`MessageDeliverySource`: the server's delivery facts once
loaded, otherwise a failure only when a note says so; `MessageItem` draws
facts through `attention/DeliveryStatus` and notes as before), and
`mentionOptions.ts`; `references/referenceLabels.ts` names references by title
(`ReferenceLabelSource`, never an id). `ChannelWorkspace` keeps the draft in
place memory under `placeKey.general(p, filter) + '#draft'`, keys its
composer by that place, and has no message types, Thread starts, or hidden
references; `MessageComposer` is controlled by that draft and keeps each send
in `channel/outbox.ts`'s `useOutbox`, drawn by `OutboxRows` (place memory under `… + '#outbox'`):
the draft clears at once, a send is a row ("Sending…", or "Not sent" with Send
again under the same client message id with the same pinned references and
Task revision, Edit and Discard) until the server
has it, and nothing is merged back into the draft. It shows the To row (`components/workspace/RecipientRow`), the
Task and reference chips, and why Send is blocked; `MessageList` renders the
timeline through `MessageItem` (Markdown with inert images, Reply and
`MoreActions`, one persistent More on coarse pointers) and `ActivityGroup`;
`ThreadPane` is read-only with "Reply in General" (only its Task link
changes). Dates and times use the app locale's date locale
(`getLocaleDateLocale`), passed down as `locale`. `MarkdownContent` reads
inline `$…$` as math only under remark-math's rules and never in code, and
`renderMathToHtml` bounds KaTeX's `maxSize` and `maxExpand`. `DmPane` keeps a per-member
`PlainDraft` under `placeKey.dm(p, m) + '#draft'` and its unsent messages in the
same outbox under `… + '#outbox'`, and `DmShareDialog` previews a
share as General will show it before posting.

Shared Workspace controls (ADR 0222): `src/components/workspace/` holds the
vocabulary Workspace views are built from — `IconButton` (required label,
tooltip, busy state, touch-sized hit area), `StatusBadge` (tone from the
semantic feedback tokens, never the only signal), `SendButton`/`StopButton`
(arrow send; a stop that names its target), and `Composer` (text, `@mention`
combobox, caller controls, send, optional stop; Enter sends, Shift+Enter breaks
the line, nothing is sent while an input method composes). It knows nothing of
channels or Tasks: `channel/MessageComposer` supplies the members to mention,
the recipients, and the reference controls, and General and direct messages
both use it.
The session composer shares the send and stop buttons.

Workspace visual vocabulary (ADR 0227): `src/kubecode/icons/workspaceIcons.ts`
maps destinations, commands, and objects to one Lucide glyph and one locale key
each. `src/components/workspace/` adds `MemberAvatar`/`MemberIdentity`,
`ReferenceChip`, `ViewHeader`, `MoreActions`, `DecisionButton`, and
`PauseButton` (new work in a named scope, distinct from a run's `StopButton`);
`kubecode.css` defines the `--ws-*` type (scoped to `.kubecode-app`, following
the UI font), spacing, reading-width, focus, and touch-target tokens (44 px on
coarse pointers). `main.tsx` renders `ControlMatrix` instead of the Workspace for
`#/controls[?theme=&lang=]`, and `tests/smoke/workspace-controls.spec.ts` checks
it in both themes and on a phone.

The browser research surface lives in `src/kubecode/research/`. `WorkbenchShell`
owns the selected question (scoped to its Project, so switching Projects clears
it) beside the selected Session, and swaps the main pane between the Session
workspace and `ResearchWorkspace`; the Project navigator shows the question list
above its Sessions. `useResearchList` and `useResearchBundle` converge on
`research_updated` events, on Session and Team lifecycle events that change link
availability, and on a return to a live stream after a drop, by refetching the
authoritative records and dropping any response older than the newest request.
Each round carries an execution section (`ResearchExecutionSection`) fed by
`useResearchExecution`, which refetches on the question's durable events and
reconnects and keeps the last known state visible, marked stale, if a refresh
fails. Destructive controls (cancel the round's execution) ask for confirmation;
pausing only stops future launches. Standalone Sessions, Teams, files, Git, and
terminals are unchanged.

The browser workspace follows the same composition pattern.
`src/kubecode/app/` owns application bootstrap, navigation, dialogs, preferences,
and the workbench shell; `src/kubecode/session/` owns the Agent Session timeline,
Composer, state, and history; `src/kubecode/api/` owns API types, queries, and the
client; and `src/kubecode/team/` owns Team feature views and lifecycle helpers.
`App.tsx` remains the application entry composition boundary,
`AgentSessionWorkspace.tsx` remains a compatibility export,
`TeamWorkspaceView.tsx` composes the Team feature views, and `api.ts` remains the
public API barrel. These top-level files preserve stable imports without
reintroducing feature implementations.

A Project may opt into Workspaces. New Agent Sessions can then execute either
at the shared Project root or in a server-managed Git worktree below the private
state directory. The chosen cwd is durable and is used by every ACP lifecycle
operation, not only the first prompt. Existing and imported Sessions remain
shared unless the user explicitly creates an isolated Session.

Every ACP stdio adapter process also starts with that execution path as its
operating-system cwd. New, load, resume, list, fork, hydrate, reconnect, and
delete therefore use the same directory at both the process and protocol layers.
Provider Session identity remains durable when an actor expires. Team drafts
initialize that identity ephemerally and release their actor until Team start.

Disabling Workspaces is a protected migration rather than a preference flip.
The server blocks on active runs, requires Merge, Export patch, or Discard for
every worktree, disconnects the ACP actor, then changes the Session cwd to the
Project root. The Project setting changes only after every worktree succeeds;
partial failures remain resumable while Workspaces stays enabled.

## Browser workspace

`src/kubecode/App.tsx` delegates to `app/WorkbenchShell.tsx`, which renders one
hierarchical Project/Session navigator, a primary Agent timeline/composer, a
docked Explorer, and a Terminal dock. The single 44-pixel title bar contains the
active Session identity, global Session search, attention, and layout controls.
Navigator visibility is global; Explorer and Terminal geometry remain
Project-scoped. All surrounding panels are resizable and independently
collapsible. Below 980 pixels, the navigator and Explorer are mutually exclusive
overlay panels with a dismissible backdrop; desktop geometry and resizing
remain unchanged.

The navigator searches, filters, sorts, groups, archives, forks, and deletes
Sessions beneath their owning Project. Query matches temporarily reveal
collapsed Projects. Needs-input and running status appears as compact row and
Project indicators. Provider-native fork or subagent relationships remain
visible, and read-only subagent transcripts do not expose a composer.

The Explorer presents independently collapsible Changes, Agent Plan, and Files
sections. Opening files creates Project-relative CodeMirror tabs without
replacing the active Agent Session; each open document retains independent
saved content and draft state. Dirty tabs require confirmation before close,
and optional browser-local Auto Save writes after one second without input.
The lazy Project tree persists expansion per Project and hides hidden,
Git-ignored, and common generated directories unless the user reveals them.
`WorkspaceService` is the single owner of these classifications: every
Project-relative directory entry carries `hidden`, `ignored`, and `generated`
flags so browser and native clients do not maintain divergent path rules.
Filesystem enumeration is isolated from the asynchronous request executor;
slow mounts and host permission mediation may delay the Files projection but
must not block health checks, Sessions, Teams, or terminals.
Each loaded directory has independent stale, loading, error, and request-generation
state. A path-scoped `file_changed` invalidates only listed entries' loaded
parents and cached subtrees, while a full invalidation, manual refresh, or SSE
open/reconnect marks every loaded directory stale. Late reads cannot cross a
newer request, cache eviction, Project switch, or unmount.
The browser derives stable visible tree rows from those directory caches. It uses
the simple DOM renderer through 200 visible rows and `react-virtuoso` above that
threshold; virtualization changes mounted rows, not path identity, expansion, or
the `tree`/`treeitem` accessibility contract. Each row retains its level,
position, expansion, selection, and keyboard focus semantics, and focus scrolls
the requested row into the mounted window. Git Conflict, Staged, and Changes
groups use the same 200-row cutoff with fixed-height keyed rows, so a large
status projection is bounded without losing status-column semantics.
For local native clients, the Project authorization route verifies a
user-selected canonical path against one registered Project and returns no
filesystem path. This allows platform-native access grants without widening
the Project-ID API boundary.
Project-relative rich-text images use the authenticated binary asset route.
The route resolves paths only through `WorkspaceService`, rejects traversal and
escaping symlinks, returns at most 8 MiB, and exposes no absolute server path.
File search is a separate flat quick-open surface available from Explorer and
Command/Ctrl-P. It traverses only the current registered Project, is bounded to
2,000 visited entries and 100 displayed results, and ignores stale asynchronous
responses. New file/folder paths and Composer file references reuse the same
keyboard-navigable path picker rather than embedding another tree. Opening a
diff remains contextual. `GitService` reads porcelain-v2 status into a projection
of at most 1 MiB and 10,000 complete records, including rename/copy source,
conflict, and truncation identity. Browser staged, unstaged, and server-generated
untracked patches are capped at 2 MiB and return a complete text patch or the
stable `binary`, `oversized`, or `unsupported` reason. A focused `useGitDiff`
hook requests the selected Project, path, and staged target, fences each response
by request generation, aborts in-flight diffs on selection change, Project change,
or unmount, and drives localized loading, unavailable, and retryable failure
states. Git reads suppress optional
locks, every Git subprocess disables terminal prompts, and patch reads disable
external diff drivers and text conversion. The Agent timeline and Composer use
one bounded content width; their scroll containers retain wheel, touch, keyboard,
and auto-follow behavior without drawing scrollbar chrome. The Composer shows
only a Plan progress summary and opens the full checklist in Explorer.
Filesystem invalidations schedule Git status through a Project-scoped controller:
the 250 millisecond debounce applies only to event-driven reads, one request may
run at a time, and activity during that request creates one follow-up. Manual
refresh and mutation responses bypass the debounce, while Project/request
generations and abort signals discard stale results. A truncated status exposes a
localized warning; loading, binary, oversized, unsupported, and failed diffs are
recoverable states with retry or refresh rather than partial patches.

The terminal dock manages independent shell or Agent TUI PTYs. Its recursive
split tree and split ratios live in browser state; PTY processes, output cursors,
and lifecycle state live on the server. A new PTY uses the selected Session's
server-validated execution path, while existing, split, and restarted PTYs keep
their original Session context. Regular terminals execute the user's shell
directly. Agent TUI profiles execute the discovered CLI through that shell in
interactive login mode so the same user-owned environment configuration is
available without putting provider-specific launch behavior in a client.
Browser refresh can restore serialized xterm output and replay newer bytes from
the server cursor. Stopping a run kills every terminal scoped to its Session
(`TerminalManager::kill_by_session`) before the ACP cancel fires, so local
child processes die immediately while provider-side cancellation catches up;
run cancellation itself is idempotent (ADR 0210).

Iconography follows ADR 0209. The `src/kubecode/icons/` module owns the size
ladder (12/14/16/20/24/28 pixels by role), the `<Icon>` wrapper that hides
decorative instances and labels icon-only controls, the `<EmojiIcon>` identity
container, and the shared workflow status definitions in `statusIcons.tsx`.
File and directory identity resolves through the vendored Material Icon Theme
subset in `icons/material/` (`resolveFileIcon`), colored by `--material-*`
tokens that are independent of the workbench theme. Icon renderers emit the
icon as the root `<svg>` element because workbench CSS sizes icons through
descendant `svg` selectors.

The component layer is the official shadcn/ui components in
`src/components/ui/` and the official AI Elements in
`src/components/ai-elements/`, installed and upgraded with the shadcn CLI
(ADR 0241). Markdown in AI Elements renders through streamdown with Kubecode's
hardening (`streamdown-hardening.ts`: no raw HTML, http/https/mailto links
only, KaTeX math). A surface that has moved onto the official parts sets
`data-ws-components="official"`, which maps the shadcn variables onto the
`--ws-*` tokens in `kubecode.css`. Until each product surface moves (slices
S1–S4 of #229), it keeps the ADR 0233 adaptations, now in
`src/components/ai-elements/workspace/` and re-exported unchanged from the
`@/components/ai-elements` barrel. Two development routes render outside the
Workspace shell on fixture data and are built on the official parts:
`#/controls` (the control matrix, with an official-components section) and
`#/prototypes` (connected screen prototypes); see ADR 0233 and ADR 0241.

## Agent sessions

The server currently discovers Claude Code, Codex, and OpenCode.
Claude and Codex use pinned ACP adapters; OpenCode exposes ACP natively. The
standalone payload currently pins Claude ACP 0.61.0 with Claude Agent SDK
0.3.217 so provider-native tools and client-provided Team MCP servers share the
upstream session lifecycle. Each
Session actor stays connected across prompts and persists the provider Session
ID for resume or load after restart.

Plain prompts admitted while a run is active queue instead of failing: the
store starts the run or enqueues the prompt in a single transaction
(`conversation_prompt_queue`, ordered by position), and admission returns
`202` with the queue item. The session actor drains the queue FIFO at every
turn boundary and on session boot, so prompts queued before a restart resume
after it (orphaned claims reset during interrupted-run recovery). The whole
pending queue broadcasts as a `prompt_queue` snapshot event after every
enqueue, mutation, claim, and drain; consumers replace their state wholesale.
Queued items are editable and removable over HTTP while they stay pending, and
cancelling the active run keeps the queue draining (ADR 0210). Structured
composer drafts still reject with `409` while a run is active because their
catalog revision must be evaluated at submission time.

Discovery records CLI and adapter health separately and can be refreshed
without restarting the server. Existing actors keep their connection; new and
reconnecting actors read the new catalog. Passive readiness never creates a
provider Session or claims authentication. A managed native client may set
`KUBECODE_DISABLE_LOGIN_SHELL_DISCOVERY=1` to skip executable lookup through
user login shells; explicit overrides, inherited PATH, and known install
locations remain available. This does not change the interactive login shell
used after an Agent TUI executable has already been selected.
Real Session startup reports a structured process, initialize, new, load, or
resume stage when it fails.

The current compatibility model maps one conversation to one Agent Session and
records an Agent Session ID, execution mode, and optional worktree path. This
keeps cwd ownership explicit while allowing multiple Agent Chats per execution
Session to be introduced additively.

Edit, Regenerate, and interrupted-turn Undo create immutable revisions inside
the same logical Agent Chat. Before truncating the active timeline, the server
copies its runs, events, and provider identity into a hidden read-only snapshot.
The visible Session ID, Team membership, cwd, and worktree remain stable. The
replacement provider Session receives an explicit recreated transcript context,
while a compact version navigator keeps earlier responses inspectable. Explicit
Fork remains the operation that creates another visible Session. Message edits
never restore Project files implicitly.

Each Git-backed run captures before/after trees through a temporary alternate
index. Restoring a Shared Session requires its current tree to match the stored
after-turn fingerprint; isolated worktree Sessions restore inside their own
boundary. Failed ACP runs also capture their final tree so interrupted-turn
Undo remains available. The real Git index and branch are never changed by
capture.

Session history is exposed as bounded cursor pages. The initial request loads
the newest 50 runs with their normalized run and Session events in chronological
display order; older pages prepend without replacing live events. Once more
than 100 runs are loaded, the browser virtualizes the variable-height timeline
while preserving the visible scroll anchor.

The Agent Composer presents the exact provider-native Session mode and dynamic
configuration in one compact control. Its trigger contains the Agent icon and
current mode; mode, model, effort, fast mode, boolean settings, and other
advertised configuration share the menu. ACP `current_mode` is preferred; a
select configuration categorized or identified as `mode` is the fallback, and
only an exactly equivalent duplicate is removed. Kubecode does not map these
values to a universal Plan/Build enum or save a default for new Sessions.

The Session state API projects whether the user can change mode and a stable
lock reason. Mode changes are rejected during an active turn and in read-only
or Team-owned contexts, so they always apply to a subsequent turn. Standard
Team Leaders own idle mode changes; Teammates and Discriminators do not. Team
YOLO owns Codex and Claude Code permission modes, while OpenCode Build/Plan
remains a Leader-editable profile because its maximum permission policy is
process-scoped.

Full ACP NewSession and LoadSession responses are durable Session-state
checkpoints. The server atomically appends the raw response to the private
Session journal and a conversation-scoped `session_state` workspace
invalidation whose browser payload is exactly `{}`; only after that transaction
commits does it publish the workspace cursor. Browsers then refetch the Session
state projection through the same request-generation and active-Session guards
used by other state invalidations. This lets provider-authored labels replace
an earlier partial mode ID without exposing `_meta` or allowing an older fetch
or a previous Session to overwrite current state.
Incremental ACP state updates use the same atomic, empty-payload invalidation
path while idle or running, so command and mode changes wake connected browsers
without placing raw provider metadata in run or workspace events.
Actor-generation guards cover both incremental updates and full checkpoints;
an evicted or replaced actor cannot overwrite state from its successor.

The Composer resolves context references, Agent and Session commands, and
user-invocable capabilities through one server-owned typed Composer catalog
(ADR 0206), not by routing everything through `/`. `@` attaches bounded
Project-relative context, `/` dispatches the Session's authoritative ACP
`available_commands`, and `$` invokes provider-advertised capabilities; each
selected item becomes a typed chip that carries an opaque server-issued ID. The
catalog is a full snapshot with a monotonic revision scoped to the Session
execution context; the browser submits opaque IDs, a revision, and ordered
draft segments, and the server revalidates revision and each reference before
resolving a private provider invocation. Standard ACP commands stay
authoritative, private adapter extensions are opt-in, and plain-text prompts
remain backward compatible. Long prompts stop growing at a bounded editor
height and scroll inside the Composer instead of resizing the Agent workspace.
The inline `$` picker and Composer `+` capability section consume the same safe
snapshot and ranking function. Trigger recognition is limited to input start or
whitespace boundaries and accepts `$`, `＄`, `¥`, and `￥`; variants normalize
only when the user selects a row. Exact, prefix, substring, subsequence, and
description matches are followed by stable scope/source ordering. Duplicate
display names remain separate opaque identities with kind, source, and scope
badges, while disabled ambiguity reasons and loading/error/empty states are
localized. Selection inserts a typed capability chip, copy emits only the
readable `$name` fallback, and paste remains plain text until an explicit
catalog selection. IME input never triggers keyboard selection or submission.
The browser-wide command palette opens with `Command-Shift-P` on macOS and
`Control-Shift-P` elsewhere. A capture-phase shortcut keeps shifted `P` separate
from the Context Workbench's unshifted file quick-open, while `Command/Control-K`
continues to focus Session search. Palette rows are grouped as local Host
actions, current-Session Agent commands, skills/capabilities, and plugin actions.
Host actions execute only typed browser handlers. Agent rows are disabled when
the active Session is missing, read-only, busy, unavailable, or incompatible;
selection never searches for another writable Session. The active Session and
catalog revision are checked again at selection time. Argument-free commands use
the opaque typed command endpoint, text-input commands focus a completed `/`
draft, and capabilities insert the same typed chip used by `$` and Composer `+`.
Closing the palette without selecting restores its prior focus target.
During the phased migration, the existing `available_commands` Session-state
field exposes only safe standard command display fields and recognized text
input shapes with optional provider-authored hints. Session state also hydrates
the durable safe catalog snapshot.
ACP updates atomically commit their private raw authority, the revised safe
catalog, and a conversation-scoped full-snapshot workspace event. `POST
/projects/:project_id/sessions/:conversation_id/commands` accepts either the
transitional exact-name selector or an opaque item ID with its catalog revision;
the typed path validates and creates its internal run in one store transaction,
then dispatches only the server-resolved prompt. Unknown slash text remains an
ordinary prompt. File, directory, Git diff, terminal-output, and Session-turn chips are
registered and batch-validated through Session-scoped Composer context endpoints. Git diff
discovery uses `GET /sessions/{conversation_id}/composer/git-diffs`; registration
submits a selector and patch revision, never patch content. Structured run requests carry
only ordered text plus opaque context/capability coordinates; filesystem
eligibility is preflighted through `WorkspaceService`, then database-owned
authorization, historical selection proof, current-catalog proof, availability,
and run creation are rechecked in one immediate store transaction. Standard ACP
commands resolve the ordered segment text as their input. Capability references
without a registered server resolver fail closed and never degrade to display
text or the legacy command-name route. Catalog revision issuance uses a durable
Session-row high-water mark that is not rewound with chat history. Rewind
reconciliation compares the retained snapshot with durable Session context
identities inside the same transaction and, when they differ, emits one new full
snapshot above that high-water mark. Structured request bounds are checked before
`WorkspaceService` resolves the exact Shared or Session-owned worktree execution
root, including for drafts with no context references. Git references are
regenerated at that root immediately before the transaction and must retain the
exact patch digest selected by the browser. Only then is the bounded patch added
to the private provider prompt; catalog snapshots and workspace events expose
numeric summaries but no patch content. Complete diffs are capped at 32 files,
128 hunks, and 64 KiB, while selected files are capped at 64 hunks and 32 KiB;
binary, generated, unsupported, and over-limit choices fail closed with stable
Composer errors rather than truncation. Safe snapshots are bounded across standard
ACP and trusted-adapter sources; invalid identities are omitted, and unsupported
trusted command shapes stay disabled rather than falling through to ACP name
resolution.

Terminal references are created only by an explicit selection or recent-output
action. Selection text is checked against the live PTY ring buffer; recent output
is captured only on the server and is capped at 120 lines and 16 KiB. ANSI, OSC,
and unsafe control data are removed and binary input is rejected. The target
Session and source terminal must resolve through `WorkspaceService` to the same
Project execution path. The private capture remains in `TerminalManager`, while
SQLite stores only its digest, private terminal selector, and safe pane/count
summary. Browser socket reconnect does not invalidate it, but PTY exit/close,
ring-buffer eviction, ownership changes, or server restart do. Provider dispatch
rechecks all of those conditions and never substitutes newer scrollback.

Session-turn references are available only for one completed, visible user turn
or Agent response in the current writable Session branch. The browser submits a
role plus the visible run or native-event anchor, while SQLite resolves that
anchor directly and reads at most 512 events from that turn. Content is capped
at 200 lines and 16 KiB and is injected only into the private provider prompt.
The durable registry and browser catalog retain an opaque ID, content digest,
role, and numeric counts, never the turn selector or content. Active, revised,
hidden-revision, cross-Session, empty, and changed turns fail closed. Explicit
branches can reference only the events copied into that branch. Diagnostics are
a separate disabled Composer type until Kubecode has an authoritative structured
Project diagnostics source; rendered editor markers and browser text are never
accepted as diagnostics authority.

Claude skill discovery is owned by the bundled adapter. Each standard Claude
`available_commands_update` is forwarded immediately, then the adapter refreshes
the exact Session query through the Claude Agent SDK's `reloadSkills()` control
request and publishes a bounded full skill inventory in private ACP `_meta`.
Refreshes are serialized per provider Session and coalesce to the latest command
snapshot, so reconnect and mid-Session skill changes replace the catalog without
restarting the actor. The adapter allowlists safe fields and never forwards a
skill path. The server's registered Claude decoder reclassifies only identities
that also match a current ACP command, persists the raw trusted snapshot with the
safe catalog revision, and reconstructs the private canonical slash invocation
after restart. Unsupported SDKs publish no skills; duplicate, disabled,
unmatched, and unsupported-input rows fail closed.

Codex skill discovery stays inside the bundled Codex ACP adapter and uses the
App Server `skills/list` result for the exact Session cwd and additional roots.
The pinned adapter dependency is compatibility-patched to publish a bounded
private `codexSkills` replacement, refresh it after `skills/changed`, and omit
configured skills from standard ACP commands because text `$skill` fallback is
not advertised. The private inventory retains the provider path as its stable
identity while the browser receives only opaque IDs, safe display fields, and
scope labels. On selection, the server revalidates the raw inventory in the run
transaction, stores only a safe `$name` display message, and places the exact
`{type: "skill", name, path}` input in ACP prompt `_meta` for that in-memory
dispatch. The patched adapter prepends that structured App Server input exactly
once and redacts paths when replaying provider history. Missing support,
malformed paths, duplicate identities, and disabled rows fail closed.

OpenCode continues to run its native `opencode acp` process without a Kubecode
adapter. Its supported native ACP implementation (verified with 1.17.20) merges
OpenCode commands and skills into `available_commands_update`, but deliberately
projects only the standard `name` and `description` fields; the internal
`source: "skill"`, source location, scope, and invocation snapshot do not cross
the ACP boundary. Kubecode therefore retains every advertised row as a `/`
`Command` and never infers a `$` capability from its name, description, provider
version, config paths, or unknown metadata. OpenCode still resolves slash
invocations natively against the exact Session cwd, so standard commands and
ordinary prompts remain available.

New, load, and resume each replace the OpenCode command snapshot for the
server-owned Session execution path. Reconnect reconstructs the same safe
catalog from the durable journal; an empty replacement removes old rows and
advances the catalog revision. A future OpenCode release may contribute `$`
items only after it advertises a stable typed identity plus a manual invocation
contract and Kubecode registers an explicit decoder. Until then the hydrated
Composer `+` menu shows a localized capability-empty status without hiding
native commands or blocking prompt submission.

While an Agent turn is running, the editor remains writable and stores an
isolated draft per Session; submission resumes after the current turn completes
or is stopped.

The bundled Claude ACP adapter advertises a private side-question capability.
During an active supported Claude turn, `/btw` dispatches the Claude Agent SDK's
native side-question request through `_claude/side_question`; its durable result
appears in a collapsible panel above the Composer without interrupting the main
turn. Unsupported adapters, Codex, and OpenCode do not expose the command. ACP
text chunks retain `messageId` so separate provider messages remain separate
response blocks during long-running output.

Team Sessions are created as Drafts with one fixed Leader. Before execution the
Team Board requires a goal, acceptance criteria, allowed installed Agents,
teammate/concurrency limits, and Standard or YOLO mode. The Leader then
dynamically adds teammate Agent Chats through the `kubecode-team` MCP server
without a second lineup-approval step. Agents that advertise HTTP receive
an authenticated streamable HTTP endpoint on new, load, and resume; the
in-process ACP bridge remains a new-session fallback for other agents.
Leader-only operations are transactionally enforced. The Leader cannot be a
task assignee, but may inspect and edit the workspace to integrate accepted
results and owns the final synthesis. Teammates claim unblocked tasks, message
one another, and submit plans or results into the Leader mailbox. An idle
Leader is automatically continued when a result or failure arrives.
Provider-native subagents remain nested under their owning member and are not
promoted into Team membership.

The Team runtime persists its lifecycle, including an explicit Paused state,
goal, acceptance criteria, Agent
allowlist, parallel/member/review limits, structured activity, and delivery
state for every mailbox message. Delegation assigns the task, creates a durable
Task Attempt, and enqueues its message in one SQLite transaction. The Attempt
binds to the internal ACP run and records queued, running, missing-report,
submitted, completed, or failed state with structured rate-limit, quota, auth,
permission, protocol, process, timeout, and interruption failures. One missing
result reminder is automatic; a second unreported completion fails the Attempt
and wakes the Leader. Runtime reconciliation resumes queued work after Team
reads, server restart, or workspace reconnect without creating a new member
Session. Delivered mailbox messages use an acknowledgement lease; reading Team
context acknowledges them, while the supervisor retries an expired lease at
most three times.

A server-owned supervisor runs at startup and every 30 seconds. It reconciles
all non-terminal Teams, recovers interrupted startup, wakes queued members,
detects a Leader that has not established a task graph, and processes lifecycle
recovery without depending on a browser connection or Team API read.

Team mode has separate requested and effective values. A requested YOLO Team
uses exact provider-native permission controls: Codex
`mode=agent-full-access`, Claude Code `mode=bypassPermissions`, and a
process-scoped OpenCode `OPENCODE_PERMISSION='{"*":"allow"}'`. If an exact
native profile is unavailable, the effective mode becomes Standard and the
Agent, stable reason code, diagnostic, and timestamp are persisted. Each member
also persists whether Kubecode applied a native permission profile and its
prior mode, allowing completion or fallback to restore permissions after a
server restart. Model, effort, fast mode, and other Agent settings are not part
of the Team permission policy.

The General Agent's Sessions use the Manager permission profile (ADR 0237,
superseding the restricted launch of ADR 0226): Claude Code runs in
`bypassPermissions` with no tools withdrawn, Codex in `agent-full-access`, and
OpenCode with the permissive `OPENCODE_PERMISSION` of a Maximum profile.
`AgentRuntime` keeps the mode locked (`RuntimeError::ManagerModeLocked`; the
session API reports `general_manager`), the member store refuses a `mode`
setting for the General Agent, and the permission handler grants any request a
manager's provider still makes with its allow-once option without surfacing it.

A current specialist's permission request from its public Session (a DM
Session's goes to the researcher) that always-allow memory does not answer
waits with `reviewer: "manager"`: it is left out of the attention
snapshot and the Session's prompt, and `Orchestrator::route_permission_review`
writes a durable `permission_review` route (source kind `permission`) to the
General Agent's public Session. Undecided after `MANAGER_REVIEW_TIMEOUT`
(120 s), or at once if the route cannot be written, `system_escalate` hands it
to the researcher and records it as `escalated` by `system` with a reason code
(`timeout`, `route_failed`). The manager
answers with the `kubecode-work` tools `permission_reviews` and
`permission_review` (approve with an agent-offered allow option, never an
always option; deny with reject-once or a cancel; or escalate, which sets
`reviewer: "user"` and publishes `permission_requested`). Only the General
Agent's current Session may call them. `AgentRuntime::manager_review_permission`
records each decision in the agent store's `manager_permission_reviews` table
and publishes `permission_reviewed` with only the request id, Session, and
decision; the attention snapshot lists the Workspace's latest decisions as
`manager_decisions`, which Needs you shows as information.

Each member's internal runs are stored only in that member's durable Chat.
Kubecode hides the synthetic wake prompt but keeps the Agent's reasoning, tool
calls, permissions, and response visible. The browser separates this member
Chat navigation from a Team control view containing setup, runtime summary,
attention, task board, dependency, verification, and activity projections.
The Team control view can pause or resume the complete Team and inspect a
selected task without opening its full prompt on every card. From the Inspector,
the user can assign, retry, cancel, open the assignee Session, or remove a
non-Leader member; destructive operations require confirmation.
Workspace `team_*` events refresh the projection without merging member
transcripts into the Leader Chat. The Team task board is the flexible main
surface: full-width status columns use the active application theme, and each
card shows only its task title and assigned member. There is no separate roster
inside this view; member Sessions remain available through Session navigation.

Teammate ACP permission requests are persisted as Team permission records and
sent to the Leader mailbox before any human controls are shown. The Leader uses
`team_review_permission` with an exact Agent-provided option or explicitly
escalates the request to the user in Standard mode. YOLO mode disables
escalation and requires a Leader decision; failure to decide becomes Team
attention rather than an implicit approval. Permission waits have no timer-based
escalation. A waiting Teammate does not consume the Leader's coordination slot,
preventing a scheduling deadlock. Leader permissions remain user-owned.

`team_complete` is the only normal Team completion transition. At least one
required task must be accepted and no permission or failed delivery may remain.
Cancelling a task atomically makes it non-required and closes its active attempt
and unresolved deliveries. Failed or cancelled work can be explicitly retried,
which restores the completion requirement and recalculates dependency blocking.
YOLO Teams additionally create a fresh Discriminator Session after required work
is accepted. Runtime chooses an allowed backend in deterministic rotation,
applies its exact read-only control (Codex `read-only`, Claude Code `plan`, or
OpenCode `plan`), and captures the Git tree fingerprint.
The Discriminator can inspect evidence and submit a pass/reject verdict but
cannot own tasks, edit implementation, or communicate outside that verdict. A
rejection returns findings to the Leader and cannot be overridden. A pass is
invalid when the workspace fingerprint changes; exhausting the configured
review rounds moves the Team to Needs Attention.

Teammate creation may apply an Agent-native ACP mode and dynamic configuration
map after the member Session is initialized. Provisioning is durable. Transport
failure rolls back the temporary member and conversation while retaining the
diagnostic; rejected configuration keeps the member in `configuring`. The
Leader can reconfigure or replace the member, retry or cancel concrete work,
and remains the only semantic scheduler.

Shared Team members execute at the Team root. Explicit isolation creates a
separate Agent Session and worktree while recording the base tree for Leader
review. Accepting an isolated file-changing result performs a private-index
three-way Git tree merge into the Leader workspace; conflicts leave the Leader
tree untouched. Existing Solo Sessions can be promoted without replacing their Chat
history or provider identity. Promotion reconnects an available provider actor
and resumes that identity with the new Team MCP endpoint; a reconnect failure
removes the new coordination record while preserving the Solo Session.

Team identity is read from durable Team and member records on every Project
load. A stale record whose conversation was removed is isolated rather than
failing the complete Team collection, and removing a Leader also removes its
coordination record. Created, promoted, and recreated ACP actors attach the
current process's Team MCP URL to provider load/resume requests. The ordinary Session deletion path rejects
direct teammate deletion before disconnecting its ACP actor. Teammates can only
be deleted by their Leader through Team MCP, so a browser action cannot bypass
Team ownership or leave a stale member. Project and global Session list responses project `team_id` and
`team_role` directly from those durable records, so navigation does not depend
on a separate Team snapshot request. Terminal, Session, and Team snapshots
hydrate independently; the browser refreshes Team snapshots while a Project is
active and immediately after the global SSE connection opens or reconnects.
Team names are persisted in the Team record. Project navigation renders each
Team as a named hierarchy with its fixed Leader first and teammates nested
below it; only Solo Sessions participate in activity/time sections.

The browser does not expose `Delete` for teammates. The Leader discovers current
member IDs with `team_list_members` and removes a teammate with
`team_remove_teammate`; that operation affects only the selected member.
Teammate removal and fixed-Leader disband are local-first operations. Kubecode
immediately removes roster and local Session state, releases assignments, and
never deletes Project files or provider-native Session history. Historical
provider-cleanup records are completed without contacting the provider.

The Leader can call `team_request_user_input` for a semantic decision it cannot
safely make. The durable request moves the Team to Needs Attention and pauses
teammate scheduling. The browser answers inline; the server resumes the prior
Team state and delivers the answer through the Leader mailbox. Completed and
disbanding Teams keep MCP coordination state read-only.

ACP capabilities drive the UI. Commands, fork, modes, configuration, plans,
permissions, elicitation, and usage appear only when advertised by the active
Agent. Kubecode does not implement a second permission-mode abstraction.

Session deletion disconnects the active actor and removes only Kubecode's
record. Provider-native history remains owned by the Agent.
Project deletion unregisters the Project and does not modify its directory.

Browser system notifications are derived from live workspace events for
completion, input-required, and error outcomes. Settings control focus policy,
categories, and whether the operating system may play its normal notification
sound. Permission is requested only from explicit UI.

Application messages use a separate React-level message host. Git, file,
Session, and Terminal operations publish typed `debug`, `info`, `success`,
`warning`, or `error` messages without invoking browser notification APIs.
The host bounds, deduplicates, expands, and dismisses diagnostic text so a
backend error cannot participate in panel sizing.

## Event model

One global SSE stream multiplexes Session, run, file, Git, and terminal metadata
events. Events have monotonically increasing IDs so reconnecting clients can
resume. The browser first reads the durable current cursor, then opens SSE from
that position so historical events cannot create stale system notifications.
SQLite is the only authority for workspace-event payloads and ordering. The
shared `AgentStore` initializes its `WorkspaceEventBus` from the latest durable
cursor. Direct inserts publish after autocommit; transactional writers,
including a batched Agent Runtime flush, publish their newest cursor only after
the complete transaction commits. Failed or rolled-back writes are silent.
The latest-value wakeup may coalesce, so consumers subscribe before a final
durable catch-up read and always replay SQLite from their own cursor. Delayed
concurrent publications cannot lower the visible cursor. Each SSE response
buffers at most one ordered 512-row SQLite page, drains it according to body
demand, and waits on its own watch receiver when caught up, so a stalled browser
cannot block writers or other consumers. A 30-second defensive read recovers a
durable row if its wake publication is missed. The response holds only a weak
store reference while idle; dropping the shared store during Runtime shutdown
closes the bus and releases waiting consumers. The bus owns no payload queue or
shutdown task.

`WorkspaceService` uses the Rust `notify` crate to recursively watch each
registered Project. Native callbacks place at most 256 paths into a non-blocking
1,024-record process queue. One owned worker normalizes and validates paths,
coalesces independently per Project after about 250 milliseconds quiet or at a
2-second maximum interval, and persists at most 256 sorted relative paths.
Queue, backend, path, or accumulation overflow becomes
`file_changed {"paths":[],"full":true}`. A scoped event uses
`{"paths":[...]}` and includes both sides of a rename. An empty scoped
`{"paths":[]}` payload is malformed and consumers fail closed to full
reconciliation; `{"paths":[],"full":true}` is the only canonical empty-path
form. Absolute, escaping, invalid, top-level `.state` paths and descendants,
and `.git` metadata paths never enter that payload.

Ordinary paths produce `file_changed`, which invalidates the affected Files
scopes and marks Git dirty. A batch containing only `.git` metadata produces a
Git-only `git_changed`; a full Files invalidation reconciles both projections.

`orchestration_updated` carries `message_id` (for routes a message carries, and
`routed`/`denied` once a message is read) so a sender's view refreshes only that
message; an attention snapshot carries the cursor read before its sources, so a
client drops a snapshot older than one it has.
Explicit API invalidations remain immediate even when watching is unavailable.
Watch registrations start with persisted Projects, follow register/unregister,
and use generations to reject late callbacks. Registration, callback, and
unregister commands share one worker: a synchronous durable append already in
progress finishes before queued unregister is processed, after which it fences
the generation and discards only not-yet-flushed pending batch state. Failed
watches retry with bounded backoff and publish a full invalidation after
recovery. Manual refresh always reads disk and Git directly. Every SSE open or
reconnect also schedules a full client reconciliation, covering a missed
process-local hint without changing durable cursor replay.
ACP text and thinking fragments are combined by a connection-scoped journal
for a fixed window of up to 33 milliseconds anchored at its first fragment.
Semantic and lifecycle events force an immediate flush, and one SQLite
transaction writes the complete window's Session, run, and workspace rows.
Flush and shutdown are persistence fences; shutdown also joins the worker before
the ACP actor exits. SSE schemas and reconnect cursors therefore remain stable
without exposing provider token boundaries as application events.
PTY bytes use dedicated WebSockets because terminal streams have different
buffering and cursor semantics.

## Distribution

GitHub Actions publishes self-contained Linux amd64 and arm64 archives and
Debian packages. Each archive contains the React build, a musl-linked Rust
server, a pinned Node.js runtime, and production-only Claude/Codex ACP bridge
dependencies. Provider Agent CLIs, credentials, Git, and the user's shell
remain host-owned.

`bin/kubecode` resolves the archive relative to itself, configures static and
adapter paths, and replaces itself with the Rust server. The server defaults to
loopback, uses `$HOME` as the directory-picker root, and stores application
state below the XDG data directory. A generic base path supports downstream
reverse proxies without binding the runtime to a specific platform.

The Debian package wraps that same directory below `/usr/lib/kubecode` and
adds `/usr/bin/kubecode`; it does not install or enable a service. Kubecode
does not publish an official container or cluster manifest. Downstream
deployments remain responsible for filesystem permissions, routing,
authentication, and persistence.
