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
}
export type ConversationHistoryPage = {
  runs: AgentRun[]
  events: Record<string, AgentEvent[]>
  session_events: SessionEvent[]
  next_cursor: string | null
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
  | 'file' | 'directory' | 'git_diff' | 'terminal' | 'session_turn' | 'diagnostics'
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
export type ComposerContextSummary =
  ComposerGitDiffSummary | ComposerTerminalSummary | ComposerSessionTurnSummary
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
export type GitFileChange = {
  path: string
  index_status: string | null
  worktree_status: string | null
}
export type GitStatus = {
  is_repository: boolean
  branch: string | null
  files: GitFileChange[]
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
