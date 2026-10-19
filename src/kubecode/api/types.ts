export type Project = {
  id: string
  name: string
  /** Legacy test/adapter input. The Runtime no longer returns server paths. */
  path?: string
  workspaces_enabled: boolean
}
export type DirectoryEntry = { name: string; path: string; hidden: boolean }
export type DirectoryListing = { path: string; parent: string | null; entries: DirectoryEntry[] }
export type Entry = {
  name: string
  path: string
  kind: 'file' | 'directory'
  hidden?: boolean
  ignored?: boolean
  generated?: boolean
}
export type TextDocument = { path: string; content: string; revision: string }
export type AgentId = 'claude_code' | 'codex' | 'opencode'
export type TeamRole = 'leader' | 'teammate' | 'discriminator'
export type TeamStatus =
  | 'draft'
  | 'starting'
  | 'active'
  | 'paused'
  | 'verifying'
  | 'needs_attention'
  | 'completed'
  | 'archived'
  | 'disbanding'
  | 'removed'
export type ExecutionMode = 'shared' | 'worktree'
export type WorkspaceMigrationStrategy = 'merge' | 'export_patch' | 'discard'
export type WorkspaceMigrationItem = {
  conversation_id: string
  title: string
  path: string
  dirty: boolean
}
export type WorkspaceMigrationPreview = {
  active_conversation_ids: string[]
  worktrees: WorkspaceMigrationItem[]
}
export type WorkspaceMigrationResolution = {
  conversation_id: string
  strategy: WorkspaceMigrationStrategy
}
export type WorkspaceMigrationResult = {
  project: Project
  exports: Array<{ conversation_id: string; path: string }>
}
export type TerminalKind = 'regular' | AgentId
export type AgentDescriptor = {
  id: AgentId
  available: boolean
  version: string | null
  executable: string
  error: string | null
  checked_at?: number
  readiness?: 'ready' | 'degraded' | 'unavailable'
  cli?: AgentComponentDiagnostic
  adapter?: AgentAdapterDiagnostic
}
export type AgentComponentDiagnostic = {
  status: 'ready' | 'missing' | 'error'
  executable: string | null
  version: string | null
  source: 'environment' | 'path' | 'login_shell' | 'known_location' | 'unresolved' | null
  error_code: string | null
  detail: string | null
}
export type AgentAdapterDiagnostic = AgentComponentDiagnostic & {
  kind: 'bundled' | 'native'
}
export type RuntimeStatus = {
  active_actor_count: number
  idle_actor_count: number
  warm_actor_limit: number
  latest_workspace_event_cursor: number
  workspace_event_delivery_available: boolean
}
/** Safe WeChat iLink connection states (ADR 0211 §4). */
export type IlinkConnectionStatus =
  | 'disconnected'
  | 'requesting_qr'
  | 'waiting_for_scan'
  | 'scanned'
  | 'verification_required'
  | 'verification_blocked'
  | 'redirecting'
  | 'connected'
  | 'backing_off'
  | 'expired'
  | 'error'
export type IlinkStatus = {
  status: IlinkConnectionStatus
  account_id: string | null
  display_name: string | null
  bound_conversation_id: string | null
  login_active: boolean
  login_expires_in_ms: number | null
  login_generation: number | null
}
/** `qr_svg` is a server-rendered image; the scan target never reaches the browser as text. */
export type IlinkLoginPoll = IlinkStatus & { qr_svg: string | null }
export type IlinkLoginStart = {
  reused: boolean
  qr_svg: string | null
  expires_in_ms: number
  generation: number
  status: IlinkConnectionStatus
}
export type IlinkQuickPrompt = { slot: number; content: string }
export type IlinkQuickPrompts = { slots: number; max_chars: number; prompts: IlinkQuickPrompt[] }
export type Conversation = {
  id: string
  agent_session_id: string
  project_id: string
  agent_id: AgentId
  provider_session_id: string | null
  title: string
  manual_title: string | null
  agent_title: string | null
  created_at?: string
  updated_at?: string
  archived?: boolean
  parent_conversation_id?: string | null
  relationship?: 'fork' | 'subagent' | 'branch' | 'team_member' | null
  read_only?: boolean
  latest_run_status?: RunStatus | null
  execution_mode: ExecutionMode
  workspace_path: string | null
  recreated_context: boolean
  team_id?: string | null
  team_role?: TeamRole | null
  team_title?: string | null
  team_status?: TeamStatus | null
}
export type ConversationRevision = {
  id: string
  conversation_id: string
  snapshot_conversation_id: string
  forked_at_run_id: string
  created_at: string
  workspace_restore?: 'restored' | 'kept'
  workspace_restore_reason?: 'checkpoint_unavailable' | 'workspace_changed' | null
}
export type TeamWorkspace = 'shared' | 'worktree'
export type TeamMode = 'standard' | 'yolo'
export type Team = {
  id: string
  project_id: string
  leader_member_id: string
  agent_session_id: string
  title: string
  status: TeamStatus
  workspace: TeamWorkspace
  workspace_path: string | null
  member_management_policy: 'ask' | 'auto'
  max_parallel_runs: number
  requested_mode: TeamMode
  mode: TeamMode
  mode_fallback: {
    agent_id: string
    reason_code: string
    reason: string
    occurred_at: string
  } | null
  goal: string
  acceptance_criteria: string[]
  allowed_agent_ids: AgentId[]
  max_teammates: number
  max_review_rounds: number
  current_review_round: number
  workspace_fingerprint: string | null
  final_summary: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}
export type TeamMember = {
  id: string
  team_id: string
  conversation_id: string
  name: string
  role: TeamRole
  status:
    | 'starting'
    | 'configuring'
    | 'queued'
    | 'idle'
    | 'working'
    | 'waiting_input'
    | 'waiting_permission'
    | 'failed'
    | 'stopped'
    | 'removing'
    | 'removed'
  workspace_mode: 'shared' | 'isolated'
  base_tree: string | null
  permission_profile_applied: boolean
  previous_permission_mode: string | null
  created_at: string
  updated_at: string
}
export type TeamTask = {
  id: string
  team_id: string
  creator_member_id: string
  assignee_member_id: string | null
  title: string
  description: string
  status: string
  completion_required: boolean
  requires_plan_approval: boolean
  plan: string | null
  mutates_files: boolean
  result: string | null
  verification: string | null
  dependencies: string[]
  owned_paths: string[]
  created_at: string
  updated_at: string
}
/** Project-scoped research (ADR 0212). */
export type ResearchStatus = 'open' | 'resolved'
export type ResearchAuthorKind = 'researcher' | 'agent' | 'system'
export type ResearchEntryKind = 'note' | 'decision' | 'proposal' | 'observation'
export type ResearchLinkKind = 'session' | 'team'
export type ResearchLinkRole = 'discussion' | 'execution'
export type ResearchSourceKind = 'session' | 'run' | 'team' | 'team_task' | 'file' | 'import'
export type ResearchSourceAvailability = 'available' | 'changed' | 'removed'
/** A typed pointer to another record; research rows hold identifiers only. */
export type ResearchSourceRef = { kind: ResearchSourceKind; id: string; revision?: string | null }
export type ResearchRoundKind = 'team' | 'solo'
/** Durable setup phases; a round that stops before `started` can be resumed. */
export type ResearchRoundPhase = 'created' | 'session_ready' | 'team_created' | 'started'
export type ResearchTargetView = {
  id: string
  title: string | null
  availability: ResearchSourceAvailability
  /** Team lifecycle status. */
  state: string | null
}
export type ResearchSourceView = ResearchSourceRef & { availability: ResearchSourceAvailability }
export type ResearchRound = {
  id: string
  research_id: string
  /** 1-based, per question. */
  round: number
  /** The brief revision this round consumed. */
  brief_revision: number
  /** True when the brief has changed since this round pinned its revision. */
  stale: boolean
  kind: ResearchRoundKind
  phase: ResearchRoundPhase
  session: ResearchTargetView | null
  team: ResearchTargetView | null
  request: { instruction?: string; [key: string]: unknown }
  sources: ResearchSourceView[]
  created_at: string
  updated_at: string
}
export type ExecutionEnvelopeState = 'active' | 'paused' | 'closed'
/** The researcher-approved limits of one round; nothing launches without them. */
export type ExecutionEnvelopeLimits = {
  max_launches: number
  max_concurrent: number
  /** Unix seconds; no launch is admitted after it. */
  deadline_at: number | null
  max_runtime_secs: number
  /** Consecutive unproductive attempts before admission refuses. */
  max_no_progress: number
  /** argv prefixes a launch must start with. */
  allowed_commands: string[][]
}
export type ExecutionEnvelope = {
  round_id: string
  research_id: string
  revision: number
  state: ExecutionEnvelopeState
  limits: ExecutionEnvelopeLimits
  launches_reserved: number
  created_at: string
  updated_at: string
}
export type ExperimentState =
  | 'reserved' | 'launching' | 'running' | 'cancelling'
  | 'exited' | 'timed_out' | 'cancelled' | 'failed_to_start' | 'unknown'
/** `pending` until an explicit analysis decision; an acknowledgement is not analysis. */
export type ExperimentAnalysis = 'none' | 'pending' | 'analyzed'
export type ExperimentWaitState = 'open' | 'resolved' | 'expired' | 'cancelled' | 'reassigned'
export type ExperimentProcessIdentity = { pid: number; start_ticks: number; boot_id: string }
export type Experiment = {
  id: string
  project_id: string
  research_id: string
  round_id: string
  team_id: string | null
  task_id: string | null
  owner_member_id: string | null
  launch_key: string
  label: string
  argv: string[]
  cwd: string
  artifacts: string[]
  sources: ResearchSourceRef[]
  /** The envelope revision this attempt was admitted under. */
  policy_revision: number
  max_runtime_secs: number
  state: ExperimentState
  analysis: ExperimentAnalysis
  identity: ExperimentProcessIdentity | null
  exit_code: number | null
  signal: number | null
  reason: string | null
  cancel_requested: boolean
  artifact_revisions: Array<{ path: string; revision: string | null }>
  created_at: string
  launched_at: string | null
  finished_at: string | null
}
/** An experiment with its artifacts re-resolved against the files as they are now. */
export type ExperimentView = Experiment & {
  artifact_state: Array<{
    path: string
    revision: string | null
    availability: ResearchSourceAvailability
  }>
}
export type ExperimentLogTail = { text: string; total_bytes: number; truncated: boolean }
export type LaunchExperimentRequest = {
  /** Retry key: repeating it returns the same attempt and starts nothing. */
  launch_key: string
  argv: string[]
  cwd?: string
  label?: string
  artifacts?: string[]
  max_runtime_secs?: number
}
export type ExperimentWait = {
  id: string
  experiment_id: string
  team_id: string
  task_id: string | null
  attempt_id: string | null
  owner_member_id: string
  expected_follow_up: string
  deadline_at: number | null
  state: ExperimentWaitState
  created_at: string
  resolved_at: string | null
}
export type ExperimentDecisionKind =
  | 'further_analysis' | 'repair' | 'retry' | 'follow_up' | 'external_wait'
  | 'researcher_input' | 'conclude'
/** The Leader's recorded reason for what happens after a result. */
export type ExperimentDecision = {
  id: string
  experiment_id: string
  member_id: string
  kind: ExperimentDecisionKind
  decision_key: string
  rationale: string
  evidence: ResearchSourceRef[]
  /** The attempt this decision started (retry / follow_up). */
  launched_experiment_id: string | null
  created_at: string
}
/** Stable codes for what would refuse another launch right now. */
export type LaunchBlocker =
  | 'no_envelope' | 'envelope_paused' | 'envelope_closed' | 'deadline_passed'
  | 'command_not_authorized' | 'launch_budget_exhausted' | 'concurrency_limit'
  | 'no_progress' | 'team_not_active'
export type ResearchExecution = {
  envelope: ExecutionEnvelope | null
  experiments: ExperimentView[]
  waits: ExperimentWait[]
  /** The Leader's recorded reasons, newest first. */
  decisions: ExperimentDecision[]
  launch_blockers: LaunchBlocker[]
  /** Server time (unix seconds), so deadlines render consistently. */
  now: number
}
export type StartResearchRoundRequest = {
  /** Idempotency key: a retry with the same key and request resumes the same round. */
  client_request_id: string
  /** The brief revision the researcher is looking at (409 if it moved). */
  expected_revision: number
  mode: ResearchRoundKind
  /** Continue in an existing Session; otherwise a new one is created for `agent_id`. */
  session_id?: string
  agent_id?: AgentId
  title?: string
  instruction?: string
  sources?: Array<Pick<ResearchSourceRef, 'kind' | 'id'>>
  leader_name?: string
  workspace?: 'shared' | 'worktree'
  acceptance_criteria?: string[]
  allowed_agent_ids?: string[]
  team_mode?: 'standard' | 'yolo'
  max_teammates?: number
  max_parallel_runs?: number
  max_review_rounds?: number
  /** The execution envelope for this round; without one nothing can launch. */
  envelope?: ExecutionEnvelopeLimits
}
/** The researcher-approved direction. */
export type ResearchBrief = {
  title: string
  question: string
  motivation: string
  hypotheses: string[]
  constraints: string[]
  evaluation_criteria: string[]
}
export type ResearchBriefPatch = Partial<ResearchBrief>
export type ResearchSummary = {
  id: string
  project_id: string
  title: string
  status: ResearchStatus
  archived: boolean
  revision: number
  entry_count: number
  link_count: number
  updated_at: string
}
export type ResearchLinkView = {
  research_id: string
  kind: ResearchLinkKind
  ref_id: string
  role: ResearchLinkRole
  created_at: string
  availability: ResearchSourceAvailability
  title: string | null
  agent_id: AgentId | null
  /** Team lifecycle status, or `archived` for an archived Session. */
  state: string | null
}
export type ResearchDetail = {
  id: string
  project_id: string
  status: ResearchStatus
  archived: boolean
  /** Current brief revision; increases only when the brief changes. */
  revision: number
  brief: ResearchBrief
  created_at: string
  updated_at: string
  resolved_at: string | null
  links: ResearchLinkView[]
}
export type ResearchEntry = {
  id: string
  research_id: string
  seq: number
  kind: ResearchEntryKind
  author_kind: ResearchAuthorKind
  author_ref: string | null
  body: string
  brief_revision: number
  created_at: string
}
export type ResearchFindingKind = 'finding' | 'attempt' | 'limitation' | 'open_question'
/** Only evidence makes an observation; everything else is an attributed interpretation. */
export type ResearchFindingBasis = 'observation' | 'interpretation'
export type ResearchOutcomeStatus = 'pending' | 'recorded' | 'declined'
export type ResearchReviewDecision = 'accepted' | 'rejected'
export type ResearchProducer = {
  session_id: string | null
  team_id: string | null
  task_id: string | null
  run_id: string | null
}
export type ResearchEvidenceView = ResearchSourceRef & { availability: ResearchSourceAvailability }
export type ResearchFinding = {
  id: string
  research_id: string
  publication_id: string
  seq: number
  kind: ResearchFindingKind
  basis: ResearchFindingBasis
  statement: string
  evidence: ResearchSourceRef[]
  evidence_state: ResearchEvidenceView[]
  producer_state: ResearchEvidenceView[]
  author_kind: ResearchAuthorKind
  author_ref: string | null
  producer: ResearchProducer
  round_id: string | null
  brief_revision: number
  /** The brief has moved on since the producing round consumed it. */
  stale: boolean
  created_at: string
}
export type CaptureResearchFindingsRequest = {
  /** Retry key: repeating it returns the stored batch. */
  publication_key: string
  /** The linked Session or Team the outcome came from. At least one. */
  session_id?: string
  team_id?: string
  round_id?: string
  findings: Array<{
    kind: ResearchFindingKind
    statement: string
    evidence?: Array<Pick<ResearchSourceRef, 'kind' | 'id'>>
  }>
}
export type CaptureResearchFindingsResponse = { created: boolean; findings: ResearchFinding[] }
/** A completed Team whose results are not yet recorded, recorded, or declined. */
export type ResearchOutcome = {
  team_id: string
  research_id: string
  round_id: string | null
  status: ResearchOutcomeStatus
  publication_id: string | null
  created_at: string
  resolved_at: string | null
}
export type ResearchProposalReview = {
  entry_id: string
  decision: ResearchReviewDecision
  note: string | null
  decided_at: string
}
export type ResearchProposal = { entry: ResearchEntry; review: ResearchProposalReview | null }
export type ResearchRevisionSummary = {
  revision: number
  title: string
  author_kind: ResearchAuthorKind
  note: string | null
  created_at: string
}
export type ResearchRevision = {
  research_id: string
  revision: number
  brief: ResearchBrief
  author_kind: ResearchAuthorKind
  author_ref: string | null
  note: string | null
  created_at: string
}
export type TeamSnapshot = {
  team: Team
  leader_conversation: Conversation
  conversations: Conversation[]
  members: TeamMember[]
  tasks: TeamTask[]
  task_attempts: TeamTaskAttempt[]
  summary: {
    running: number
    queued: number
    needs_attention: number
    done: number
    total_tasks: number
  }
  proposal: TeamProposal | null
  permissions: TeamPermissionRequest[]
  activity: TeamActivity[]
  attention: TeamAttention[]
  next_actions?: TeamNextAction[]
  user_input_requests?: TeamUserInputRequest[]
  lifecycle_operations?: TeamLifecycleOperation[]
  discrimination_rounds: TeamDiscriminationRound[]
}
export type TeamNextAction = {
  id: string
  kind: 'answer_user_input' | 'configure_member'
  label: string
}
export type TeamUserInputRequest = {
  id: string
  team_id: string
  requester_member_id: string
  title: string
  prompt: string
  resume_status: Team['status']
  status: 'pending' | 'resolved'
  answer: string | null
  created_at: string
  resolved_at: string | null
}
export type TeamLifecycleOperation = {
  id: string
  team_id: string
  project_id: string
  kind: 'provisioning' | 'provider_cleanup' | 'disband'
  status: 'pending' | 'running' | 'retry_scheduled' | 'failed' | 'completed'
  member_id: string | null
  conversation_id: string | null
  payload_json: string
  attempt_count: number
  next_attempt_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}
export type TeamTaskAttempt = {
  id: string
  team_id: string
  task_id: string
  member_id: string
  run_id: string | null
  status: 'queued' | 'running' | 'needs_report' | 'result_submitted' | 'completed' | 'failed' | 'cancelled'
  failure_kind: 'rate_limit' | 'quota' | 'auth' | 'permission_denied' | 'process' | 'protocol' | 'timeout' | 'interrupted' | 'unknown' | null
  error: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}
export type StartTeamInput = {
  goal: string
  acceptance_criteria: string[]
  allowed_agent_ids: AgentId[]
  mode: TeamMode
  max_teammates: number
  max_parallel_runs: number
  max_review_rounds: number
}
export type TeamDiscriminationRound = {
  id: string
  team_id: string
  discriminator_member_id: string
  round: number
  workspace_fingerprint: string
  status: 'running' | 'passed' | 'rejected' | 'error'
  verdict: string | null
  evidence: string | null
  created_at: string
  resolved_at: string | null
}
export type TeamPermissionRequest = {
  id: string
  team_id: string
  member_id: string
  conversation_id: string
  run_id: string
  tool: string
  input_json: string
  options_json: string
  status: 'pending_leader' | 'waiting_user' | 'resolved' | 'cancelled'
  selected_option_id: string | null
  reason: string | null
  decided_by: string | null
  decided_by_member_id: string | null
  created_at: string
  resolved_at: string | null
}
export type TeamProposal = {
  id: string
  team_id: string
  summary: string
  members_json: string
  status: 'pending' | 'approved' | 'rejected'
  created_at: string
  resolved_at: string | null
}
export type TeamActivity = {
  id: number
  team_id: string
  member_id: string | null
  task_id: string | null
  kind: string
  summary: string
  metadata_json: string | null
  created_at: string
}
export type TeamAttention = {
  id: string
  kind: string
  member_id: string | null
  task_id: string | null
  summary: string
}
export type RunStatus =
  | 'running'
  | 'waiting_permission'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'interrupted'
export type AgentRun = {
  id: string
  conversation_id: string
  project_id: string
  message: string
  status: RunStatus
  permission_mode: 'safe' | 'power'
  error: string | null
  internal?: boolean
  client_message_id?: string
  /** Typed terminal cause carried by run completion events (#92). */
  terminal_cause?:
    | 'end_turn'
    | 'cancelled'
    | 'error'
    | 'max_tokens'
    | 'max_turn_requests'
    | 'refusal'
    | 'interrupted'
}
/** A prompt durably queued while another run is active (#95). */
export type PromptQueueItem = {
  id: string
  conversation_id: string
  project_id: string
  content: string
  status: 'pending' | 'claimed'
  position: number
  internal: boolean
  client_message_id?: string
  created_at: string
}

/** Admission result for a plain prompt: started now, or queued (#95/#97). */
export type RunAdmission =
  | { admission: 'started'; run: AgentRun }
  | { admission: 'queued'; item: PromptQueueItem }

export type ConversationHistoryPage = {
  runs: AgentRun[]
  events: Record<string, AgentEvent[]>
  session_events: SessionEvent[]
  next_cursor: string | null
  /** Global workspace cursor at snapshot time (see #103 hydration dedupe). */
  workspace_cursor?: number
}
export type AgentEvent = {
  run_id: string
  seq: number
  kind: string
  payload: Record<string, unknown>
  created_at: string
}
export type SessionEvent = {
  conversation_id: string
  seq: number
  kind: string
  payload: Record<string, unknown>
  created_at: string
}
export type AgentSessionState = {
  capabilities: Record<string, unknown> | null
  available_commands: Record<string, unknown> | null
  current_mode: Record<string, unknown> | null
  config_options: Record<string, unknown> | null
  plan: Record<string, unknown> | null
  usage: Record<string, unknown> | null
  composer?: {
    catalog: ComposerCatalogSnapshot
  }
  mode_access?: {
    can_change: boolean
    reason: NativeModeLockReason | null
  }
}
export type ComposerItemKind = 'command' | 'skill' | 'plugin_action' | 'provider_app'
export type ComposerContextKind =
  | 'file' | 'directory' | 'git_diff' | 'terminal' | 'session_turn' | 'project_context'
  | 'diagnostics'
export type ComposerGitDiffSummary = {
  kind: 'git_diff'
  scope: 'all' | 'file'
  file_count: number
  hunk_count: number
  byte_count: number
}
export type ComposerTerminalSummary = {
  kind: 'terminal'
  capture: 'selection' | 'recent'
  pane_index: number
  line_count: number
  byte_count: number
  truncated: boolean
}
export type ComposerSessionTurnSummary = {
  kind: 'session_turn'
  role: 'user' | 'agent'
  line_count: number
  byte_count: number
}
/** Display data only: the reference is the opaque id; the server re-resolves it at dispatch. */
export type ComposerProjectContextSummary = {
  kind: 'project_context'
  ref_kind: ProjectContextKind
  revision: string
  title: string
}
export type ComposerContextSummary =
  | ComposerGitDiffSummary
  | ComposerTerminalSummary
  | ComposerSessionTurnSummary
  | ComposerProjectContextSummary
export type ComposerCatalogItem = {
  id: string
  kind: ComposerItemKind
  name: string
  description: string | null
  source_label: string
  scope: 'session' | 'project' | 'user' | 'bundled' | 'plugin'
  input_hint: string | null
  enabled: boolean
  disabled_reason: string | null
}
export type ComposerCatalogContext = {
  id: string
  kind: ComposerContextKind
  display: string
  enabled: boolean
  disabled_reason: string | null
  summary?: ComposerContextSummary
}
export type GitDiffContextCandidate = {
  path: string | null
  source_revision: string
  file_count: number
  hunk_count: number
  byte_count: number
  enabled: boolean
  disabled_reason: string | null
}
export type GitDiffContextList = {
  is_repository: boolean
  candidates: GitDiffContextCandidate[]
}
export type ComposerCatalogSnapshot = {
  conversation_id: string
  revision: number
  items: ComposerCatalogItem[]
  contexts: ComposerCatalogContext[]
}
export type ComposerContextSelector = {
  id: string
  catalog_revision: number
  context_kind: ComposerContextKind
}
export type ComposerContextRegistration = {
  context: ComposerCatalogContext
  catalog: ComposerCatalogSnapshot
}
export type ComposerContextValidationResponse = {
  references: Array<ComposerContextSelector & { available: boolean }>
  catalog: ComposerCatalogSnapshot
}
export type StructuredComposerSegment =
  | { kind: 'text'; text: string }
  | (ComposerContextSelector & { kind: 'context_ref' })
  | {
      kind: 'capability_ref'
      id: string
      catalog_revision: number
      item_kind: ComposerItemKind
    }
export type StructuredComposerRunRequest = {
  item_id?: string
  catalog_revision: number
  segments: StructuredComposerSegment[]
  client_message_id?: string
}
export type SideQuestionAccepted = {
  id: string
  status: 'pending'
}
export type NativeModeLockReason =
  | 'active_run'
  | 'read_only'
  | 'team_discriminator'
  | 'team_teammate'
  | 'team_yolo_permission'
export type ProviderSessionInfo = {
  session_id: string
  cwd: string
  title: string | null
  updated_at: string | null
}
export type WorkspaceEvent = {
  id: number
  kind: string
  project_id: string | null
  conversation_id: string | null
  run_id: string | null
  payload: Record<string, unknown>
  created_at: string
}
export type FileChangedPayload = {
  paths: string[]
  full?: boolean
}
export type GitFileChange = {
  path: string
  original_path?: string
  index_status: string | null
  worktree_status: string | null
  conflict: boolean
}
export type GitStatus = {
  is_repository: boolean
  branch: string | null
  files: GitFileChange[]
  truncated: boolean
}
export type GitDiffUnavailableReason = 'binary' | 'oversized' | 'unsupported'
export type GitDiffResult = {
  diff: string | null
  unavailable_reason: GitDiffUnavailableReason | null
}
export type GitMutation = 'stage' | 'unstage' | 'discard'
export type TerminalInfo = {
  id: string
  project_id: string
  conversation_id: string | null
  title: string
  kind: TerminalKind
  cols: number
  rows: number
  status: 'running' | 'exited'
  exit_code: number | null
  signal: string | null
}

export type ProjectContextKind =
  | 'research'
  | 'round'
  | 'import'
  | 'finding'
  | 'session'
  | 'session_turn'
  | 'team'
  | 'team_task'
  | 'experiment'
  | 'artifact'
  | 'work'
  | 'thread'
  | 'channel'
export type ProjectContextDetail = 'summary' | 'content' | 'evidence'
/** A typed pointer; `revision` is a change fingerprint, not a snapshot. */
export type ProjectContextRef = { kind: ProjectContextKind; id: string; revision?: string | null }
export type ProjectContextProvenance = {
  author: string | null
  updated_at: string | null
  research_id: string | null
  parent: ProjectContextRef | null
  state: string | null
}
export type ProjectContextItem = {
  ref: ProjectContextRef
  title: string
  summary: string
  provenance: ProjectContextProvenance
  availability: ResearchSourceAvailability
}
export type ProjectContextPage = {
  items: ProjectContextItem[]
  next_cursor: string | null
  truncated: boolean
}
export type ProjectContextSection = { heading: string; text: string; truncated: boolean }
export type ProjectContextDocument = {
  ref: ProjectContextRef
  detail: ProjectContextDetail
  title: string
  availability: ResearchSourceAvailability
  provenance: ProjectContextProvenance
  sections: ProjectContextSection[]
  related: ProjectContextItem[]
  next_cursor: string | null
  notes: string[]
}
export type ProjectContextResolved = {
  ref: ProjectContextRef
  availability: ResearchSourceAvailability
  current_revision: string | null
}

/** Imported discussion (ADR 0214 §8): attributed source material, never a finding. */
export type ResearchImportOrigin = 'paste' | 'markdown'
export type ResearchImportCandidateKind =
  | 'question'
  | 'hypothesis'
  | 'decision'
  | 'constraint'
  | 'evaluation_criterion'
  | 'open_question'
export type ResearchImport = {
  id: string
  research_id: string
  origin: ResearchImportOrigin
  label: string
  /** The brief revision the discussion was about, as the researcher stated it. */
  based_on_revision: number
  digest: string
  byte_count: number
  created_at: string
  current_revision: number
  /** The brief has moved on since the discussion was written. */
  stale: boolean
}
/** A suggestion found in the text; none is an approved change. */
export type ResearchImportCandidate = {
  kind: ResearchImportCandidateKind
  text: string
  line: number
}
export type ResearchImportDetail = ResearchImport & {
  content: string
  candidates: ResearchImportCandidate[]
}
export type CreateResearchImportRequest = {
  origin: ResearchImportOrigin
  label: string
  content: string
  based_on_revision?: number
  client_request_id: string
}
export type ResearchPacketSectionId =
  | 'brief'
  | 'progress'
  | 'findings'
  | 'evidence'
  | 'open_questions'
export type ResearchExportPacket = {
  research_id: string
  brief_revision: number
  sections: Array<{
    id: ResearchPacketSectionId
    included: boolean
    bytes: number
    /** The section was cut at its own size budget. */
    truncated: boolean
  }>
  markdown: string
  total_bytes: number
  truncated: boolean
}

/** The Workspace conversation (ADR 0216): channels, messages, and Threads. */
export type ChannelAuthorKind = 'researcher' | 'agent' | 'system'
export type ChannelMessageKind = 'message' | 'system'
/** What a message asks for; recorded only, never acted on by saving it. */
export type ChannelIntent = 'say' | 'ask' | 'request'
export type Channel = {
  id: string
  project_id: string
  name: string
  is_default: boolean
  last_seq: number
  created_at: string
}
export type ChannelMention = { session_id: string }
export type ChannelMessage = {
  id: string
  project_id: string
  channel_id: string
  thread_id: string | null
  seq: number
  kind: ChannelMessageKind
  author_kind: ChannelAuthorKind
  author_ref: string | null
  body: string
  intent: ChannelIntent
  mentions: ChannelMention[]
  references: ProjectContextRef[]
  client_message_id: string | null
  intent_claimed_by: string | null
  created_at: string
  /** The Task (research question) the message is about. */
  task_id: string | null
  /** The earlier message this one cites. */
  reply_to: string | null
  /** Hand-off depth: 0 for the researcher's own message. */
  hops: number
}
export type ChannelMessagePage = { messages: ChannelMessage[]; has_more: boolean }
export type ChannelThread = {
  id: string
  project_id: string
  channel_id: string
  root_message_id: string
  title: string
  research_id: string | null
  round_id: string | null
  revision: number
  reply_count: number
  last_seq: number
  created_by: string | null
  created_at: string
  updated_at: string
}
export type NewChannelMessage = {
  body: string
  threadId?: string | null
  clientMessageId?: string
  intent?: ChannelIntent
  mentions?: ChannelMention[]
  references?: ProjectContextRef[]
  /** An earlier message of the conversation this one answers or cites. */
  replyTo?: string | null
}

/** Tasks (ADR 0221): research questions on the board, read as one model. */
export type TaskStage = 'ready' | 'in_progress' | 'review' | 'done'
export type TaskCondition = 'none' | 'waiting' | 'blocked' | 'paused' | 'needs_input'
export type TaskCard = {
  /** The research question's id: the Task's one identity. */
  id: string
  project_id: string
  title: string
  question: string
  stage: TaskStage
  condition: TaskCondition
  condition_reason: string | null
  /** The scientific outcome once the researcher accepted it. */
  outcome?: WorkOutcome | null
  revision: number
  approved_revision: number
  admitted_at: string
  origin: 'conversation' | 'legacy_round'
  authorizing_message_id: string | null
  participants: { member_id: string; name: string; handle: string; role: 'general' | 'specialist' }[]
  open_questions: number
  review_requested: boolean
  updated_at: string
}
export type TaskBoard = {
  cards: TaskCard[]
  stages: { stage: TaskStage; count: number }[]
  total: number
}
export type TaskDraft = {
  id: string
  project_id: string
  title: string
  question: string
  revision: number
  proposed_by: string
  updated_at: string
}

/** One Task as the inspector reads it (ADR 0221). */
export type TaskRevisionNote = {
  revision: number
  author_kind: string
  approved: boolean
  created_at: string
}
export type TaskReviewRequest = {
  id: string
  research_id: string
  summary: string
  /** Cited evidence as `kind:id`. */
  evidence: string[]
  requested_by: string
  brief_revision: number
  state: 'open' | 'accepted' | 'returned'
  created_at: string
  resolved_at: string | null
}
export type TaskReviewRecord = {
  id: string
  research_id: string
  request_id: string
  accepted: boolean
  outcome: WorkOutcome
  reason: string | null
  brief_revision: number
  created_at: string
}
export type TaskInternalWork = {
  id: string
  title: string
  stage: WorkStage
  condition: WorkCondition
  lifecycle: WorkLifecycle
  attempts: number
  experiments: number
  assignee: { member_id: string; name: string; handle: string; role: string } | null
}
export type TaskStaleEvidence = {
  work_id: string
  result_id: string
  kind: string
  ref_id: string
  status: 'changed' | 'removed'
}
export type TaskDetail = TaskCard & {
  brief: ResearchBrief
  revisions: TaskRevisionNote[]
  authorizing_message: { id: string; body: string; created_at: string } | null
  review_requests: TaskReviewRequest[]
  reviews: TaskReviewRecord[]
  internal_work: TaskInternalWork[]
  open_questions: Array<WorkDecisionRequest & { work_title: string }>
  stale_evidence: TaskStaleEvidence[]
}

/** A turn of the researcher's private conversation with a member (ADR 0223). */
export type DmTurn = { run_id: string; user: string; assistant: string }
/** Exactly what sharing from a private conversation would post to General. */
export type DmSharePreview = { text: string; digest: string; task_id: string | null }
export type DmShareRequest = {
  runIds: string[]
  note?: string
  taskId?: string | null
  digest?: string
  clientMessageId?: string
}

/** The Workspace work board (ADR 0218): one projection of the canonical work records. */
export type WorkStage = 'planned' | 'ready' | 'executing' | 'analyzing' | 'review' | 'done'
export type WorkCondition = 'none' | 'waiting' | 'blocked' | 'paused' | 'needs_input'
export type WorkLifecycle = 'active' | 'canceled' | 'abandoned' | 'superseded'
export type WorkAcceptance = 'pending' | 'accepted' | 'rejected'
export type WorkOutcome = 'unknown' | 'supported' | 'refuted' | 'inconclusive'
export type WorkOrigin = 'native' | 'legacy_team'
export type WorkAttemptStatus =
  | 'queued'
  | 'running'
  | 'needs_report'
  | 'result_submitted'
  | 'completed'
  | 'failed'
  | 'cancelled'
export type WorkItem = {
  id: string
  project_id: string
  research_id: string | null
  round_id: string | null
  team_id: string | null
  origin: WorkOrigin
  kind: string
  title: string
  description: string
  plan: string | null
  result: string | null
  verification: string | null
  stage: WorkStage
  condition: WorkCondition
  condition_reason: string | null
  review_kind: 'plan' | 'result' | 'code' | 'validity' | 'evidence' | null
  lifecycle: WorkLifecycle
  closed_reason: string | null
  superseded_by: string | null
  acceptance: WorkAcceptance
  outcome: WorkOutcome
  priority: number
  /** Bumped by plan and dependency changes. */
  revision: number
  /** Bumped by every change; commands are refused if it moved on. */
  state_revision: number
  derived_from: { kind: string; id: string } | null
  dependencies: string[]
  created_by: string | null
  created_at: string
  updated_at: string
}
export type WorkAttempt = {
  id: string
  task_id: string
  assignment_id: string | null
  conversation_id: string | null
  run_id: string | null
  status: WorkAttemptStatus
  failure_kind: string | null
  error: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}
export type WorkAssignment = {
  id: string
  task_id: string
  conversation_id: string
  member_id: string | null
  assigned_by: string | null
  started_at: string
  ended_at: string | null
  end_reason: string | null
}
export type WorkResultRef = {
  id: string
  task_id: string
  attempt_id: string | null
  role: 'result' | 'evidence' | 'artifact'
  kind: string
  ref_id: string
  revision: string | null
  created_at: string
}
export type WorkDependencyState = {
  id: string
  title: string
  stage: WorkStage
  lifecycle: WorkLifecycle
  acceptance: WorkAcceptance
}
export type WorkBlocker =
  | { kind: 'dependency'; work_id: string; title: string; closed: boolean }
  | { kind: 'condition'; condition: WorkCondition; reason: string | null }
export type WorkRouteState = 'pending' | 'delivered' | 'failed'
export type WorkCard = {
  item: WorkItem
  assignment: WorkAssignment | null
  latest_attempt: WorkAttempt | null
  attempt_count: number
  results: WorkResultRef[]
  dependency_states: WorkDependencyState[]
  supersedes: string[]
  experiment_count: number
  last_activity_at: string
  research: { id: string; title: string } | null
  round: { id: string; number: number } | null
  team: { id: string; title: string } | null
  executor: {
    session_id: string
    title: string
    agent_id: AgentId | null
    /** False when the assigned Session was removed or is no longer visible. */
    available: boolean
  } | null
  origin_thread: { id: string; title: string } | null
  blockers: WorkBlocker[]
  /** `native` work is commanded here; `legacy_team` work is commanded through its Team. */
  operable: 'native' | 'legacy_team'
  delivery: { kind: string; state: WorkRouteState; last_error: string | null } | null
}
export type WorkBoard = {
  cards: WorkCard[]
  stages: Array<{ stage: WorkStage; count: number }>
  conditions: Array<{ condition: WorkCondition; count: number }>
  total: number
  truncated: boolean
  closed: WorkCard[]
  closed_truncated: boolean
}
export type WorkReview = {
  id: string
  task_id: string
  kind: string
  accepted: boolean
  outcome: WorkOutcome
  reviewer: string
  reason: string | null
  inputs: string[]
  created_at: string
}
export type WorkRouteBrief = {
  id: string
  kind: string
  state: WorkRouteState
  attempts: number
  last_error: string | null
  created_at: string
  delivered_at: string | null
}
export type WorkDetail = WorkCard & {
  attempts: WorkAttempt[]
  assignments: WorkAssignment[]
  reviews: WorkReview[]
  routes: WorkRouteBrief[]
  experiments: Array<{
    id: string
    label: string
    state: string
    analysis: string
    exit_code: number | null
    created_at: string
  }>
  /** What was decided about each finished experiment of the task. */
  decisions: WorkExperimentDecision[]
  /** Questions an agent put to the researcher, oldest first. */
  decision_requests: WorkDecisionRequest[]
  /** Cited evidence that no longer matches what was attached. */
  stale_evidence: WorkStaleEvidence[]
}
export type WorkDecisionKind =
  | 'further_analysis'
  | 'repair'
  | 'retry'
  | 'follow_up'
  | 'external_wait'
  | 'researcher_input'
  | 'conclude'
export type WorkExperimentDecision = {
  id: string
  experiment_id: string
  kind: WorkDecisionKind
  rationale: string
  launched_experiment_id: string | null
  created_at: string
}
export type WorkDecisionRequest = {
  id: string
  work_id: string
  question: string
  options: string[]
  impact: string | null
  asked_by: string
  state: 'open' | 'answered'
  answer: string | null
  created_at: string
}
export type WorkStaleEvidence = {
  result_id: string
  kind: string
  ref_id: string
  status: 'changed' | 'removed'
}
/** Narrows the one board; no filter creates another. */
export type WorkBoardFilter = {
  research_id?: string
  round_id?: string
  team_id?: string
  conversation_id?: string
  thread_id?: string
  condition?: WorkCondition
  origin?: WorkOrigin
  include_closed?: boolean
}
export type WorkCommand =
  | { command: 'start'; request_key: string }
  | { command: 'assign'; session_id: string; reason?: string }
  | { command: 'pause'; reason?: string }
  | { command: 'resume' }
  | { command: 'prioritize'; priority: number; expected_revision: number }
  | { command: 'review'; accept: boolean; outcome?: WorkOutcome; reason?: string }
  | { command: 'repin'; result_id: string }
  | {
    command: 'close'
    lifecycle: Exclude<WorkLifecycle, 'active'>
    reason: string
    expected_revision: number
    superseded_by?: string
  }

// -- Workspace members (ADR 0220) ---------------------------------------------------------------
export type MemberRole = 'general' | 'specialist'
export type MemberTemplate = 'general' | 'analysis' | 'writing' | 'code_review' | 'custom'
export type MemberState = 'active' | 'setup_required' | 'removed'
/** What a member runs on: a provider, provider-reported configuration values, and instructions. */
export type MemberSpec = {
  agent_id: AgentId
  config: Record<string, string>
  instructions: string
}
export type Member = {
  id: string
  project_id: string
  role: MemberRole
  template: MemberTemplate
  name: string
  /** The `@handle` used to mention the member. */
  handle: string
  spec: MemberSpec
  public_conversation_id: string | null
  dm_conversation_id: string | null
  state: MemberState
  setup_error: string | null
  /** `provider_unavailable` or `config_rejected`: the browser words these itself. */
  setup_code: 'provider_unavailable' | 'config_rejected' | null
  revision: number
  created_at: string
  updated_at: string
  removed_at: string | null
}
export type MemberRoster = { members: Member[]; general_id: string | null }
export type MemberDefaults = {
  revision: number
  general: MemberSpec
  templates: Partial<Record<MemberTemplate, string>>
}
export type MemberInput = {
  name: string
  template?: MemberTemplate
  spec?: MemberSpec
  client_request_id?: string
}
export type MemberPatch = { name?: string; template?: MemberTemplate; spec?: MemberSpec }
