export type Project = {
  id: string
  name: string
  path: string
  workspaces_enabled: boolean
}
export type DirectoryEntry = { name: string; path: string; hidden: boolean }
export type DirectoryListing = { path: string; parent: string | null; entries: DirectoryEntry[] }
export type Entry = { name: string; path: string; kind: 'file' | 'directory' }
export type TextDocument = { path: string; content: string; revision: string }
export type AgentId = 'claude_code' | 'codex' | 'opencode'
export type TeamRole = 'leader' | 'teammate' | 'discriminator'
export type TeamStatus =
  | 'draft'
  | 'starting'
  | 'active'
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
  kind: 'answer_user_input' | 'configure_member' | 'retry_cleanup'
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
}
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
  title: string
  kind: TerminalKind
  cols: number
  rows: number
  status: 'running' | 'exited'
  exit_code: number | null
  signal: string | null
}

export class ApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(
    code: string,
    message: string,
    status: number,
  ) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

export function apiBasePath(pathname: string): string {
  const prefix = pathname.replace(/\/+$/, '')
  return `${prefix === '/' ? '' : prefix}/api/v1`
}

export class KubecodeApi {
  readonly basePath: string

  constructor(basePath = window.location.pathname) {
    this.basePath = apiBasePath(basePath)
  }

  listProjects(): Promise<Project[]> {
    return this.request('/projects')
  }

  listDirectories(path?: string): Promise<DirectoryListing> {
    return this.request(`/filesystem/directories?${query({ path })}`)
  }

  createProject(path: string): Promise<Project> {
    return this.request('/projects', {
      method: 'POST',
      body: JSON.stringify({ kind: 'create', path }),
    })
  }

  importProject(path: string): Promise<Project> {
    return this.request('/projects', {
      method: 'POST',
      body: JSON.stringify({ kind: 'import', path }),
    })
  }

  unregisterProject(projectId: string): Promise<void> {
    return this.request(`/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' })
  }

  setProjectWorkspacesEnabled(projectId: string, enabled: boolean): Promise<Project> {
    return this.request(`${this.projectPath(projectId)}/workspaces`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    })
  }

  getWorkspaceMigration(projectId: string): Promise<WorkspaceMigrationPreview> {
    return this.request(`${this.projectPath(projectId)}/workspaces/migration`)
  }

  migrateProjectWorkspaces(
    projectId: string,
    resolutions: WorkspaceMigrationResolution[],
  ): Promise<WorkspaceMigrationResult> {
    return this.request(`${this.projectPath(projectId)}/workspaces/migration`, {
      method: 'POST',
      body: JSON.stringify({ resolutions }),
    })
  }

  listEntries(projectId: string, path = ''): Promise<Entry[]> {
    return this.request(`${this.projectPath(projectId)}/entries?${query({ path })}`)
  }

  createEntry(projectId: string, path: string, kind: Entry['kind']): Promise<void> {
    return this.request(`${this.projectPath(projectId)}/entries`, {
      method: 'POST',
      body: JSON.stringify({ path, kind }),
    })
  }

  renameEntry(projectId: string, from: string, to: string): Promise<void> {
    return this.request(`${this.projectPath(projectId)}/entries`, {
      method: 'PATCH',
      body: JSON.stringify({ from, to }),
    })
  }

  deleteEntry(projectId: string, path: string): Promise<void> {
    return this.request(`${this.projectPath(projectId)}/entries?${query({ path })}`, {
      method: 'DELETE',
    })
  }

  readFile(projectId: string, path: string): Promise<TextDocument> {
    return this.request(`${this.projectPath(projectId)}/file?${query({ path })}`)
  }

  writeFile(projectId: string, path: string, content: string, revision: string): Promise<TextDocument> {
    return this.request(`${this.projectPath(projectId)}/file?${query({ path })}`, {
      method: 'PUT',
      body: JSON.stringify({ content, revision }),
    })
  }

  gitStatus(projectId: string): Promise<GitStatus> {
    return this.request(`${this.projectPath(projectId)}/git/status`)
  }

  initializeGit(projectId: string): Promise<GitStatus> {
    return this.request(`${this.projectPath(projectId)}/git/init`, { method: 'POST' })
  }

  gitDiff(projectId: string, path: string, staged: boolean): Promise<string> {
    return this.request<{ diff: string }>(
      `${this.projectPath(projectId)}/git/diff?${query({ path, staged: String(staged) })}`,
    ).then((result) => result.diff)
  }

  mutateGit(projectId: string, action: GitMutation, paths: string[]): Promise<GitStatus> {
    return this.request(`${this.projectPath(projectId)}/git/mutate`, {
      method: 'POST',
      body: JSON.stringify({ action, paths }),
    })
  }

  commitGit(projectId: string, message: string): Promise<GitStatus> {
    return this.request(`${this.projectPath(projectId)}/git/commit`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    })
  }

  listAgents(): Promise<AgentDescriptor[]> {
    return this.request('/agents')
  }

  listConversations(projectId: string): Promise<Conversation[]> {
    return this.request(`${this.projectPath(projectId)}/sessions`)
  }

  listSessions(): Promise<Conversation[]> {
    return this.request('/sessions')
  }

  listProviderSessions(projectId: string, agentId: AgentId): Promise<ProviderSessionInfo[]> {
    return this.request(
      `${this.projectPath(projectId)}/agents/${encodeURIComponent(agentId)}/sessions`,
    )
  }

  createConversation(
    projectId: string,
    agentId: AgentId,
    title?: string,
    providerSessionId?: string,
    agentTitle?: string,
    workspaceMode?: ExecutionMode,
  ): Promise<Conversation> {
    return this.request(`${this.projectPath(projectId)}/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        agent_id: agentId,
        agent_title: agentTitle || undefined,
        provider_session_id: providerSessionId || undefined,
        title: title || undefined,
        workspace_mode: workspaceMode === 'worktree' ? workspaceMode : undefined,
      }),
    })
  }

  listTeams(projectId: string): Promise<TeamSnapshot[]> {
    return this.request(`${this.projectPath(projectId)}/teams`)
  }

  getTeam(teamId: string): Promise<TeamSnapshot> {
    return this.request(`/teams/${encodeURIComponent(teamId)}`)
  }

  startTeam(teamId: string, input: StartTeamInput): Promise<TeamSnapshot> {
    return this.request(`/teams/${encodeURIComponent(teamId)}/start`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  completeTeam(
    teamId: string,
    finalSummary: string,
  ): Promise<TeamSnapshot> {
    return this.request(`/teams/${encodeURIComponent(teamId)}/complete`, {
      method: 'POST',
      body: JSON.stringify({
        final_summary: finalSummary,
      }),
    })
  }

  resolveTeamUserInput(
    teamId: string,
    requestId: string,
    answer: string,
  ): Promise<TeamSnapshot> {
    return this.request(
      `/teams/${encodeURIComponent(teamId)}/attention/${encodeURIComponent(requestId)}/resolve`,
      { method: 'POST', body: JSON.stringify({ answer }) },
    )
  }

  retryTeamCleanup(teamId: string, operationId: string): Promise<TeamLifecycleOperation> {
    return this.request(
      `/teams/${encodeURIComponent(teamId)}/cleanup/${encodeURIComponent(operationId)}/retry`,
      { method: 'POST' },
    )
  }

  updateTeamSettings(
    teamId: string,
    memberManagementPolicy: Team['member_management_policy'],
    maxParallelRuns: number,
  ): Promise<TeamSnapshot> {
    return this.request(`/teams/${encodeURIComponent(teamId)}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({
        member_management_policy: memberManagementPolicy,
        max_parallel_runs: maxParallelRuns,
      }),
    })
  }

  resolveTeamProposal(
    teamId: string,
    proposalId: string,
    decision: 'approved' | 'rejected',
  ): Promise<TeamSnapshot> {
    return this.request(
      `/teams/${encodeURIComponent(teamId)}/proposals/${encodeURIComponent(proposalId)}/decision`,
      { method: 'POST', body: JSON.stringify({ decision }) },
    )
  }

  createTeam(
    projectId: string,
    agentId: AgentId,
    leaderName: string,
    title?: string,
    workspace: TeamWorkspace = 'shared',
  ): Promise<TeamSnapshot> {
    return this.request(`${this.projectPath(projectId)}/teams`, {
      method: 'POST',
      body: JSON.stringify({
        agent_id: agentId,
        leader_name: leaderName,
        title: title || undefined,
        workspace,
      }),
    })
  }

  promoteToTeam(
    conversationId: string,
    leaderName: string,
    title?: string,
  ): Promise<TeamSnapshot> {
    return this.request(`/sessions/${encodeURIComponent(conversationId)}/promote-to-team`, {
      method: 'POST',
      body: JSON.stringify({ leader_name: leaderName, title: title || undefined }),
    })
  }

  updateConversation(conversationId: string, manualTitle: string | null): Promise<Conversation> {
    return this.request(`/sessions/${encodeURIComponent(conversationId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ manual_title: manualTitle }),
    })
  }

  archiveConversation(conversationId: string, archived: boolean): Promise<Conversation> {
    return this.request(`/sessions/${encodeURIComponent(conversationId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ archived }),
    })
  }

  deleteConversation(conversationId: string): Promise<void> {
    return this.request(`/sessions/${encodeURIComponent(conversationId)}`, {
      method: 'DELETE',
    })
  }

  forkConversation(conversationId: string): Promise<Conversation> {
    return this.request(`/sessions/${encodeURIComponent(conversationId)}/fork`, { method: 'POST' })
  }

  branchConversationAtRun(
    conversationId: string,
    runId: string,
    restoreFiles = true,
  ): Promise<Conversation> {
    return this.request(
      `/sessions/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(runId)}/branch`,
      { method: 'POST', body: JSON.stringify({ restore_files: restoreFiles }) },
    )
  }

  reviseConversationAtRun(
    conversationId: string,
    runId: string,
  ): Promise<ConversationRevision> {
    return this.request(
      `/sessions/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(runId)}/revise`,
      { method: 'POST' },
    )
  }

  listConversationRevisions(conversationId: string): Promise<ConversationRevision[]> {
    return this.request(`/sessions/${encodeURIComponent(conversationId)}/revisions`)
  }

  createTeamMember(
    conversationId: string,
    agentId: AgentId,
    isolated: boolean,
  ): Promise<Conversation> {
    return this.request(`/sessions/${encodeURIComponent(conversationId)}/team-members`, {
      method: 'POST',
      body: JSON.stringify({ agent_id: agentId, isolated }),
    })
  }

  startRun(
    projectId: string,
    conversationId: string,
    message: string,
  ): Promise<AgentRun> {
    return this.request(
      `${this.projectPath(projectId)}/sessions/${encodeURIComponent(conversationId)}/runs`,
      {
        method: 'POST',
        body: JSON.stringify({ message }),
      },
    )
  }

  listRuns(conversationId: string): Promise<AgentRun[]> {
    return this.request(`/sessions/${encodeURIComponent(conversationId)}/runs`)
  }

  listProjectRuns(projectId: string): Promise<AgentRun[]> {
    return this.request(`${this.projectPath(projectId)}/runs`)
  }

  getRun(runId: string): Promise<AgentRun> {
    return this.request(`/runs/${encodeURIComponent(runId)}`)
  }

  listEvents(runId: string, after = 0): Promise<AgentEvent[]> {
    return this.request(`/runs/${encodeURIComponent(runId)}/events?${query({ after })}`)
  }

  listSessionEvents(conversationId: string, after = 0): Promise<SessionEvent[]> {
    return this.request(`/sessions/${encodeURIComponent(conversationId)}/events?${query({ after })}`)
  }

  getSessionState(conversationId: string): Promise<AgentSessionState> {
    return this.request(`/sessions/${encodeURIComponent(conversationId)}/state`)
  }

  setSessionMode(conversationId: string, value: string): Promise<void> {
    return this.request(`/sessions/${encodeURIComponent(conversationId)}/options`, {
      method: 'PATCH',
      body: JSON.stringify({ kind: 'mode', value }),
    })
  }

  setSessionConfig(conversationId: string, configId: string, value: string | boolean): Promise<void> {
    return this.request(`/sessions/${encodeURIComponent(conversationId)}/options`, {
      method: 'PATCH',
      body: JSON.stringify({ kind: 'config', config_id: configId, value }),
    })
  }

  eventStreamUrl(runId: string, after = 0): string {
    return `${this.basePath}/runs/${encodeURIComponent(runId)}/events/stream?${query({ after })}`
  }

  workspaceEventStreamUrl(after = 0): string {
    return `${this.basePath}/events?${query({ after })}`
  }

  workspaceEventCursor(): Promise<number> {
    return this.request<{ cursor: number }>('/events/cursor').then(({ cursor }) => cursor)
  }

  cancelRun(runId: string): Promise<void> {
    return this.request(`/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' })
  }

  resolvePermission(requestId: string, optionId: string): Promise<void> {
    return this.request(`/permissions/${encodeURIComponent(requestId)}`, {
      method: 'POST',
      body: JSON.stringify({ option_id: optionId }),
    })
  }

  resolveElicitation(
    requestId: string,
    content: Record<string, string | number | boolean | string[]> | null,
  ): Promise<void> {
    return this.request(`/elicitations/${encodeURIComponent(requestId)}`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    })
  }

  listTerminals(projectId: string): Promise<TerminalInfo[]> {
    return this.request(`${this.projectPath(projectId)}/terminals`)
  }

  createTerminal(
    projectId: string,
    kind: TerminalKind,
    cols: number,
    rows: number,
  ): Promise<TerminalInfo> {
    return this.request(`${this.projectPath(projectId)}/terminals`, {
      method: 'POST',
      body: JSON.stringify({ kind, cols, rows }),
    })
  }

  closeTerminal(terminalId: string): Promise<void> {
    return this.request(`/terminals/${encodeURIComponent(terminalId)}`, { method: 'DELETE' })
  }

  updateTerminal(terminalId: string, title: string): Promise<TerminalInfo> {
    return this.request(`/terminals/${encodeURIComponent(terminalId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    })
  }

  terminalSocket(projectId: string, terminalId: string, cursor: number): WebSocket {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const path = `${this.basePath}${this.projectPath(projectId)}/terminals/${encodeURIComponent(terminalId)}/attach`
    return new WebSocket(`${protocol}//${window.location.host}${path}?${query({ cursor })}`)
  }

  private projectPath(projectId: string): string {
    return `/projects/${encodeURIComponent(projectId)}`
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('accept', 'application/json')
    if (init.body) headers.set('content-type', 'application/json')
    const response = await fetch(`${this.basePath}${path}`, { ...init, headers })
    if (!response.ok) {
      const error = await response.json().catch(() => ({
        code: 'request_failed',
        message: response.statusText || `Request failed (${response.status})`,
      })) as { code?: string; message?: string }
      throw new ApiError(
        error.code ?? 'request_failed',
        error.message ?? `Request failed (${response.status})`,
        response.status,
      )
    }
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return undefined as T
    }
    return response.json() as Promise<T>
  }
}

function query(values: Record<string, string | number | undefined>): string {
  return new URLSearchParams(
    Object.entries(values).flatMap(([key, value]) => (
      value === undefined ? [] : [[key, String(value)]]
    )),
  ).toString()
}
