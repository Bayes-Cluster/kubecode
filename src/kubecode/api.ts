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
export type ExecutionMode = 'shared' | 'worktree'
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
  relationship?: 'fork' | 'subagent' | null
  read_only?: boolean
  latest_run_status?: RunStatus | null
  execution_mode: ExecutionMode
  workspace_path: string | null
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

  removeConversation(conversationId: string, scope: 'local' | 'provider' = 'local'): Promise<void> {
    return this.request(`/sessions/${encodeURIComponent(conversationId)}?${query({ scope })}`, {
      method: 'DELETE',
    })
  }

  forkConversation(conversationId: string): Promise<Conversation> {
    return this.request(`/sessions/${encodeURIComponent(conversationId)}/fork`, { method: 'POST' })
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
