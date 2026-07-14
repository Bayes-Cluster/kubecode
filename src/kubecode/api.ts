export type Project = { id: string; name: string; path: string }
export type Entry = { name: string; path: string; kind: 'file' | 'directory' }
export type TextDocument = { path: string; content: string; revision: string }
export type AgentId = 'claude_code' | 'codex' | 'opencode'
export type AgentDescriptor = {
  id: AgentId
  available: boolean
  version: string | null
  executable: string
  error: string | null
}
export type Conversation = {
  id: string
  project_id: string
  agent_id: AgentId
  provider_session_id: string | null
  title: string
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
export type TerminalInfo = { id: string; project_id: string; cols: number; rows: number }

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

  createProject(parent: string, name: string): Promise<Project> {
    return this.request('/projects', {
      method: 'POST',
      body: JSON.stringify({ kind: 'create', parent, name }),
    })
  }

  importProject(path: string, name?: string): Promise<Project> {
    return this.request('/projects', {
      method: 'POST',
      body: JSON.stringify({ kind: 'import', path, name: name || undefined }),
    })
  }

  unregisterProject(projectId: string): Promise<void> {
    return this.request(`/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' })
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

  listAgents(): Promise<AgentDescriptor[]> {
    return this.request('/agents')
  }

  listConversations(projectId: string): Promise<Conversation[]> {
    return this.request(`${this.projectPath(projectId)}/conversations`)
  }

  createConversation(projectId: string, agentId: AgentId, title?: string): Promise<Conversation> {
    return this.request(`${this.projectPath(projectId)}/conversations`, {
      method: 'POST',
      body: JSON.stringify({ agent_id: agentId, title: title || undefined }),
    })
  }

  startRun(
    projectId: string,
    conversationId: string,
    message: string,
    permissionMode: 'safe' | 'power',
  ): Promise<AgentRun> {
    return this.request(
      `${this.projectPath(projectId)}/conversations/${encodeURIComponent(conversationId)}/runs`,
      {
        method: 'POST',
        body: JSON.stringify({ message, permission_mode: permissionMode }),
      },
    )
  }

  getRun(runId: string): Promise<AgentRun> {
    return this.request(`/runs/${encodeURIComponent(runId)}`)
  }

  listEvents(runId: string, after = 0): Promise<AgentEvent[]> {
    return this.request(`/runs/${encodeURIComponent(runId)}/events?${query({ after })}`)
  }

  eventStreamUrl(runId: string, after = 0): string {
    return `${this.basePath}/runs/${encodeURIComponent(runId)}/events/stream?${query({ after })}`
  }

  cancelRun(runId: string): Promise<void> {
    return this.request(`/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' })
  }

  listTerminals(projectId: string): Promise<TerminalInfo[]> {
    return this.request(`${this.projectPath(projectId)}/terminals`)
  }

  createTerminal(projectId: string, cols: number, rows: number): Promise<TerminalInfo> {
    return this.request(`${this.projectPath(projectId)}/terminals`, {
      method: 'POST',
      body: JSON.stringify({ cols, rows }),
    })
  }

  closeTerminal(terminalId: string): Promise<void> {
    return this.request(`/terminals/${encodeURIComponent(terminalId)}`, { method: 'DELETE' })
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

function query(values: Record<string, string | number>): string {
  return new URLSearchParams(
    Object.entries(values).map(([key, value]) => [key, String(value)]),
  ).toString()
}
