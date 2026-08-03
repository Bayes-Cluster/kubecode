import type {
  AgentDescriptor,
  AgentId,
  AgentRun,
  AgentSessionState,
  AgentEvent,
  ComposerContextKind,
  ComposerContextRegistration,
  ComposerContextSelector,
  ComposerContextValidationResponse,
  Conversation,
  ConversationHistoryPage,
  ConversationRevision,
  DirectoryListing,
  Entry,
  ExecutionMode,
  GitDiffContextList,
  GitDiffResult,
  GitMutation,
  GitStatus,
  Project,
  ProviderSessionInfo,
  RuntimeStatus,
  SessionEvent,
  SideQuestionAccepted,
  StartTeamInput,
  StructuredComposerRunRequest,
  Team,
  TeamSnapshot,
  TeamWorkspace,
  TerminalInfo,
  TerminalKind,
  TextDocument,
  WorkspaceMigrationPreview,
  WorkspaceMigrationResolution,
  WorkspaceMigrationResult,
} from './types'
import { query } from './queries'

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly stage: string | null

  constructor(
    code: string,
    message: string,
    status: number,
    stage: string | null = null,
  ) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.stage = stage
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

  listSessionEntries(conversationId: string, path = '', signal?: AbortSignal): Promise<Entry[]> {
    return this.request(
      `/sessions/${encodeURIComponent(conversationId)}/entries?${query({ path })}`,
      { signal },
    )
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

  gitStatus(projectId: string, signal?: AbortSignal): Promise<GitStatus> {
    return this.request(`${this.projectPath(projectId)}/git/status`, { signal })
  }

  initializeGit(projectId: string): Promise<GitStatus> {
    return this.request(`${this.projectPath(projectId)}/git/init`, { method: 'POST' })
  }

  gitDiff(projectId: string, path: string, staged: boolean): Promise<GitDiffResult> {
    return this.request<GitDiffResult>(
      `${this.projectPath(projectId)}/git/diff?${query({ path, staged: String(staged) })}`,
    )
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

  refreshAgents(): Promise<AgentDescriptor[]> {
    return this.request('/agents/refresh', { method: 'POST' })
  }

  runtimeStatus(): Promise<RuntimeStatus> {
    return this.request('/runtime/status')
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

  pauseTeam(teamId: string): Promise<TeamSnapshot> {
    return this.request(`/teams/${encodeURIComponent(teamId)}/pause`, { method: 'POST' })
  }

  resumeTeam(teamId: string): Promise<TeamSnapshot> {
    return this.request(`/teams/${encodeURIComponent(teamId)}/resume`, { method: 'POST' })
  }

  retryTeamTask(teamId: string, taskId: string): Promise<TeamSnapshot> {
    return this.request(
      `/teams/${encodeURIComponent(teamId)}/tasks/${encodeURIComponent(taskId)}/retry`,
      { method: 'POST' },
    )
  }

  cancelTeamTask(teamId: string, taskId: string, reason?: string): Promise<TeamSnapshot> {
    return this.request(
      `/teams/${encodeURIComponent(teamId)}/tasks/${encodeURIComponent(taskId)}/cancel`,
      { method: 'POST', body: JSON.stringify({ reason: reason || undefined }) },
    )
  }

  assignTeamTask(teamId: string, taskId: string, memberId: string): Promise<TeamSnapshot> {
    return this.request(
      `/teams/${encodeURIComponent(teamId)}/tasks/${encodeURIComponent(taskId)}/assign`,
      { method: 'POST', body: JSON.stringify({ member_id: memberId }) },
    )
  }

  removeTeamMember(teamId: string, memberId: string): Promise<TeamSnapshot> {
    return this.request(
      `/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(memberId)}`,
      { method: 'DELETE' },
    )
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

  startStructuredRun(
    projectId: string,
    conversationId: string,
    request: StructuredComposerRunRequest,
  ): Promise<AgentRun> {
    return this.request(
      `${this.projectPath(projectId)}/sessions/${encodeURIComponent(conversationId)}/runs`,
      {
        method: 'POST',
        body: JSON.stringify(request),
      },
    )
  }

  registerComposerContext(
    conversationId: string,
    context: {
      kind: ComposerContextKind
      path: string
      source_revision?: string
      terminal_id?: string
      selected_text?: string
      turn_id?: string
    },
  ): Promise<ComposerContextRegistration> {
    return this.request(
      `/sessions/${encodeURIComponent(conversationId)}/composer/contexts`,
      {
        method: 'POST',
        body: JSON.stringify(context),
      },
    )
  }

  listComposerGitDiffs(conversationId: string, signal?: AbortSignal): Promise<GitDiffContextList> {
    return this.request(
      `/sessions/${encodeURIComponent(conversationId)}/composer/git-diffs`,
      { signal },
    )
  }

  validateComposerContexts(
    conversationId: string,
    references: ComposerContextSelector[],
  ): Promise<ComposerContextValidationResponse> {
    return this.request(
      `/sessions/${encodeURIComponent(conversationId)}/composer/contexts/validate`,
      {
        method: 'POST',
        body: JSON.stringify({ references }),
      },
    )
  }

  dispatchAcpCommand(
    projectId: string,
    conversationId: string,
    name: string,
    commandArguments: string,
  ): Promise<AgentRun> {
    return this.request(
      `${this.projectPath(projectId)}/sessions/${encodeURIComponent(conversationId)}/commands`,
      {
        method: 'POST',
        body: JSON.stringify({ name, arguments: commandArguments }),
      },
    )
  }

  dispatchComposerCommand(
    projectId: string,
    conversationId: string,
    itemId: string,
    catalogRevision: number,
    commandArguments: string,
  ): Promise<AgentRun> {
    return this.request(
      `${this.projectPath(projectId)}/sessions/${encodeURIComponent(conversationId)}/commands`,
      {
        method: 'POST',
        body: JSON.stringify({
          item_id: itemId,
          catalog_revision: catalogRevision,
          arguments: commandArguments,
        }),
      },
    )
  }

  listRuns(conversationId: string): Promise<AgentRun[]> {
    return this.request(`/sessions/${encodeURIComponent(conversationId)}/runs`)
  }

  getConversationHistory(
    conversationId: string,
    before?: string,
    limit = 50,
  ): Promise<ConversationHistoryPage> {
    return this.request(
      `/sessions/${encodeURIComponent(conversationId)}/history?${query({ before, limit })}`,
    )
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

  askSideQuestion(conversationId: string, question: string): Promise<SideQuestionAccepted> {
    return this.request(`/sessions/${encodeURIComponent(conversationId)}/side-questions`, {
      method: 'POST',
      body: JSON.stringify({ question }),
    })
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
    conversationId?: string,
  ): Promise<TerminalInfo> {
    return this.request(`${this.projectPath(projectId)}/terminals`, {
      method: 'POST',
      body: JSON.stringify({ kind, cols, rows, conversation_id: conversationId }),
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
      })) as { code?: string; message?: string; stage?: string }
      throw new ApiError(
        error.code ?? 'request_failed',
        error.message ?? `Request failed (${response.status})`,
        response.status,
        error.stage ?? null,
      )
    }
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return undefined as T
    }
    return response.json() as Promise<T>
  }
}
