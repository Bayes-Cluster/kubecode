import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { KubecodeApp } from './App'
import type { KubecodeApi, TerminalInfo } from './api'

vi.mock('./TerminalView', () => ({
  TerminalView: ({ terminal }: { terminal: TerminalInfo }) => (
    <div data-testid={`terminal-${terminal.id}`}>{terminal.title}</div>
  ),
}))

describe('Kubecode workspace', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.unstubAllGlobals())

  it.each(['create', 'import'] as const)(
    'deduplicates a %s completion when the session SSE refresh arrives first',
    async (mode) => {
      const originalEventSource = globalThis.EventSource
      class TestEventSource {
        static current: TestEventSource | null = null
        onerror: ((event: Event) => void) | null = null
        private listener: ((event: MessageEvent<string>) => void) | null = null

        constructor() { TestEventSource.current = this }
        addEventListener(_type: string, listener: EventListener) {
          this.listener = listener as (event: MessageEvent<string>) => void
        }
        close() {}
        emit(event: unknown) {
          this.listener?.(new MessageEvent('workspace_event', { data: JSON.stringify(event) }))
        }
      }
      globalThis.EventSource = TestEventSource as unknown as typeof EventSource
      let finishCreate: ((conversation: {
        id: string
        project_id: string
        agent_id: 'codex'
        provider_session_id: string
        title: string
        manual_title: string | null
        agent_title: string | null
      }) => void) | undefined
      const created = {
        id: 'session-race',
        project_id: 'project-1',
        agent_id: 'codex' as const,
        provider_session_id: 'provider-race',
        title: 'Race session',
        manual_title: 'Race session',
        agent_title: null,
      }
      const createPending = new Promise<typeof created>((resolve) => { finishCreate = resolve })
      const listConversations = vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([created])
      const api = {
        listProjects: vi.fn().mockResolvedValue([{ id: 'project-1', name: 'Demo', path: '/demo' }]),
        listAgents: vi.fn().mockResolvedValue([
          { id: 'codex', available: true, version: 'test', executable: 'codex', error: null },
        ]),
        listEntries: vi.fn().mockResolvedValue([]),
        listTerminals: vi.fn().mockResolvedValue([]),
        listConversations,
        listProviderSessions: vi.fn().mockResolvedValue([{
          session_id: 'provider-race',
          cwd: '/demo',
          title: 'Race session',
          updated_at: 'now',
        }]),
        createConversation: vi.fn().mockReturnValue(createPending),
        gitStatus: vi.fn().mockResolvedValue({ is_repository: false, branch: null, files: [] }),
        workspaceEventStreamUrl: vi.fn().mockReturnValue('/events'),
        listRuns: vi.fn().mockResolvedValue([]),
        listSessionEvents: vi.fn().mockResolvedValue([]),
        getSessionState: vi.fn().mockResolvedValue({
          capabilities: null,
          available_commands: null,
          current_mode: null,
          config_options: null,
          plan: null,
          usage: null,
        }),
      } as unknown as KubecodeApi

      try {
        render(<KubecodeApp api={api} />)
        await screen.findByRole('button', { name: 'New session' })
        fireEvent.click(screen.getByRole('button', { name: 'New session' }))
        if (mode === 'import') {
          fireEvent.click(screen.getByRole('button', { name: 'Import Agent session' }))
          await screen.findByText('Race session')
        } else {
          fireEvent.change(screen.getByRole('textbox', { name: 'Session title' }), {
            target: { value: 'Race session' },
          })
        }
        fireEvent.click(screen.getByRole('button', { name: mode === 'import' ? 'Import' : 'Create' }))
        act(() => {
          TestEventSource.current?.emit({
            id: 1,
            kind: mode === 'import' ? 'session_imported' : 'session_created',
            project_id: 'project-1',
            conversation_id: created.id,
            run_id: null,
            payload: {},
            created_at: 'now',
          })
        })
        await waitFor(() => expect(listConversations).toHaveBeenCalledTimes(2))
        await act(async () => finishCreate?.(created))

        await waitFor(() => {
          expect(screen.getAllByRole('button', { name: 'Race session' })).toHaveLength(1)
        })
      } finally {
        globalThis.EventSource = originalEventSource
      }
    },
  )

  it('uses project and session navigation with the agent session as the primary workspace', async () => {
    const api = {
      listProjects: vi.fn().mockResolvedValue([
        { id: 'project-1', name: 'Demo', path: 'demo' },
      ]),
      listAgents: vi.fn().mockResolvedValue([]),
      listEntries: vi.fn().mockResolvedValue([]),
      listTerminals: vi.fn().mockResolvedValue([]),
      listConversations: vi.fn().mockResolvedValue([]),
      gitStatus: vi.fn().mockResolvedValue({ is_repository: false, branch: null, files: [] }),
    } as unknown as KubecodeApi

    const { container } = render(<KubecodeApp api={api} />)

    expect(await screen.findByRole('button', { name: 'Demo' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New session' })).toBeInTheDocument()
    expect(screen.getByTestId('agent-session-workspace')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Toggle sessions' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Toggle terminal' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Toggle context panel' })).toHaveAttribute('aria-pressed', 'true')
    const titlebarActions = container.querySelector('.kubecode-topbar-actions')
    expect(titlebarActions).toContainElement(screen.getByRole('button', { name: 'Toggle sessions' }))
    expect(titlebarActions).toContainElement(screen.getByRole('button', { name: 'Toggle terminal' }))
    expect(titlebarActions).toContainElement(screen.getByRole('button', { name: 'Toggle context panel' }))
    expect(Array.from(titlebarActions?.querySelectorAll('.kubecode-layout-toggle') ?? []).map(
      (button) => button.getAttribute('aria-label'),
    )).toEqual(['Toggle sessions', 'Toggle terminal', 'Toggle context panel'])
    expect(screen.getByRole('tab', { name: 'Explorer' })).toHaveAttribute('data-state', 'active')
    expect(screen.getByRole('button', { name: 'Changes' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Files' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.queryByText('Select a file to start editing')).not.toBeInTheDocument()
  })

  it('delivers a test notification and reports the result in Settings', async () => {
    class MockNotification {
      static deliveries: string[] = []
      static permission: NotificationPermission = 'granted'
      static requestPermission = vi.fn(async () => 'granted' as NotificationPermission)

      constructor(title: string) { MockNotification.deliveries.push(title) }
    }
    vi.stubGlobal('Notification', MockNotification)
    const api = {
      listProjects: vi.fn().mockResolvedValue([]),
      listAgents: vi.fn().mockResolvedValue([]),
    } as unknown as KubecodeApi

    render(<KubecodeApp api={api} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send test' }))

    await waitFor(() => expect(MockNotification.deliveries).toEqual([
      'Kubecode notifications are ready',
    ]))
    expect(screen.getByRole('status')).toHaveTextContent('Kubecode notifications are ready')
  })

  it('applies a user-selected UI font size from Appearance settings', async () => {
    const api = {
      listProjects: vi.fn().mockResolvedValue([]),
      listAgents: vi.fn().mockResolvedValue([]),
    } as unknown as KubecodeApi

    render(<KubecodeApp api={api} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('combobox', { name: 'UI Font Size' }))
    fireEvent.click(await screen.findByRole('option', { name: '16px' }))

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--kubecode-ui-font-size')).toBe('16px')
    })
  })

  it('persists the browser-wide teammate chat preference from Agent settings', async () => {
    const api = {
      listProjects: vi.fn().mockResolvedValue([]),
      listAgents: vi.fn().mockResolvedValue([]),
    } as unknown as KubecodeApi

    render(<KubecodeApp api={api} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Agents' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Allow direct teammate chat' }))

    await waitFor(() => expect(localStorage.getItem('kubecode:agent-preferences:v1'))
      .toBe('{"allowTeammateChat":true}'))
  })

  it('refreshes and explains Agent readiness from Settings', async () => {
    const refreshAgents = vi.fn().mockResolvedValue([{
      id: 'opencode',
      available: true,
      version: '2.0',
      executable: '/usr/bin/opencode',
      error: null,
      checked_at: 1,
      readiness: 'ready',
      cli: {
        status: 'ready',
        executable: '/usr/bin/opencode',
        version: '2.0',
        source: 'path',
        error_code: null,
        detail: null,
      },
      adapter: {
        kind: 'native',
        status: 'ready',
        executable: '/usr/bin/opencode',
        version: '2.0',
        source: null,
        error_code: null,
        detail: null,
      },
    }])
    const api = {
      listProjects: vi.fn().mockResolvedValue([]),
      listAgents: vi.fn().mockResolvedValue([{
        id: 'opencode',
        available: false,
        version: null,
        executable: 'opencode',
        error: 'missing',
      }]),
      refreshAgents,
    } as unknown as KubecodeApi

    render(<KubecodeApp api={api} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Agents' }))
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: 'Check again' }))

    await waitFor(() => expect(refreshAgents).toHaveBeenCalledOnce())
    expect((await dialog.findAllByText('2.0')).length).toBeGreaterThan(0)
    fireEvent.click(dialog.getByText('OpenCode'))
    expect(dialog.getByText('Authentication is checked when a real Session starts.')).toBeInTheDocument()
  })

  it('shows every Runtime connection state with keyboard access and action-scoped retry', async () => {
    class StatusEventSource {
      static current: StatusEventSource | null = null
      static instances: StatusEventSource[] = []
      onerror: (() => void) | null = null
      onopen: (() => void) | null = null
      readonly url: string
      constructor(url: string | URL) {
        this.url = String(url)
        StatusEventSource.current = this
        StatusEventSource.instances.push(this)
      }
      addEventListener() {}
      close() {}
    }
    vi.stubGlobal('EventSource', StatusEventSource)
    let finishRecovery: (() => void) | undefined
    const heldRecovery = new Promise<never[]>((resolve) => { finishRecovery = () => resolve([]) })
    const listSessions = vi.fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('recovery failed'))
      .mockImplementationOnce(() => heldRecovery)
    const workspaceEventStreamUrl = vi.fn().mockReturnValue('/events?after=0')
    const api = settingsApi({ listSessions, workspaceEventStreamUrl })

    render(<KubecodeApp api={api} />)
    const connecting = await screen.findByRole('button', { name: 'Runtime connection: Connecting' })
    connecting.focus()
    fireEvent.keyDown(connecting, { key: 'Enter' })
    expect(await screen.findByText('Never')).toBeInTheDocument()
    fireEvent.keyDown(document.activeElement ?? connecting, { key: 'Escape' })

    act(() => StatusEventSource.current?.onopen?.())
    expect(screen.getByRole('button', { name: 'Runtime connection: Live' })).toBeInTheDocument()
    act(() => StatusEventSource.current?.onerror?.())
    const reconnecting = screen.getByRole('button', { name: 'Runtime connection: Reconnecting' })
    act(() => StatusEventSource.current?.onopen?.())
    await screen.findByRole('button', { name: 'Runtime connection: Reconnecting' })
    fireEvent.pointerDown(reconnecting, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    const retry = await screen.findByRole('menuitem', { name: 'Retry' })
    await act(async () => {
      retry.focus()
      fireEvent.keyDown(retry, { key: 'Enter', code: 'Enter' })
    })

    expect(screen.getByRole('button', { name: 'Runtime connection: Resynchronizing' })).toBeInTheDocument()
    expect(listSessions).toHaveBeenCalledTimes(3)
    expect(StatusEventSource.instances).toHaveLength(1)
    expect(StatusEventSource.instances[0]?.url).toBe('/events?after=0')
    expect(workspaceEventStreamUrl).toHaveBeenCalledTimes(1)
    expect(workspaceEventStreamUrl).toHaveBeenCalledWith(0)
    await act(async () => { finishRecovery?.() })
    expect(await screen.findByRole('button', { name: 'Runtime connection: Live' })).toBeInTheDocument()
    expect(listSessions).toHaveBeenCalledTimes(3)
    expect(StatusEventSource.instances).toHaveLength(1)
    expect(screen.queryByRole('menuitem', { name: 'Retry' })).not.toBeInTheDocument()
  })

  it('loads and refreshes only the public Runtime capacity fields', async () => {
    let finishInitial: ((value: unknown) => void) | undefined
    let finishRefresh: ((value: unknown) => void) | undefined
    const runtimeStatus = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { finishInitial = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = resolve }))
    render(<KubecodeApp api={settingsApi({ runtimeStatus })} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Agents' }))
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Loading Runtime status')
    expect(screen.getByRole('button', { name: 'Refresh Runtime status' })).toBeDisabled()

    let sensitiveFieldReads = 0
    await act(async () => finishInitial?.({
      active_actor_count: 2,
      idle_actor_count: 3,
      warm_actor_limit: 5,
      get latest_workspace_event_cursor() {
        sensitiveFieldReads += 1
        return 987654
      },
      workspace_event_delivery_available: true,
      get private_path() {
        sensitiveFieldReads += 1
        return '/srv/private-project'
      },
      get prompt() {
        sensitiveFieldReads += 1
        return 'private prompt'
      },
      get credential() {
        sensitiveFieldReads += 1
        return 'secret credential'
      },
    }))
    const panel = screen.getByTestId('runtime-status-panel')
    expect(within(panel).getByText('2')).toBeInTheDocument()
    expect(within(panel).getByText('3')).toBeInTheDocument()
    expect(within(panel).getByText('5')).toBeInTheDocument()
    expect(panel).not.toHaveTextContent('987654')
    expect(panel).not.toHaveTextContent('/srv/private-project')
    expect(panel).not.toHaveTextContent('private prompt')
    expect(panel).not.toHaveTextContent('secret credential')
    expect(sensitiveFieldReads).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: 'Refresh Runtime status' }))
    expect(screen.getByRole('button', { name: 'Refresh Runtime status' })).toBeDisabled()
    await act(async () => finishRefresh?.({
      active_actor_count: 4,
      idle_actor_count: 1,
      warm_actor_limit: 6,
      latest_workspace_event_cursor: 999999,
      workspace_event_delivery_available: true,
    }))
    expect(within(panel).getByText('4')).toBeInTheDocument()
    expect(runtimeStatus).toHaveBeenCalledTimes(2)
  })

  it.each(['success', 'error'] as const)(
    'ignores a stale Runtime status %s after Settings closes',
    async (outcome) => {
      let finishStale: ((value: unknown) => void) | undefined
      let failStale: ((error: Error) => void) | undefined
      let finishCurrent: ((value: unknown) => void) | undefined
      const runtimeStatus = vi.fn()
        .mockImplementationOnce(() => new Promise((resolve, reject) => {
          finishStale = resolve
          failStale = reject
        }))
        .mockImplementationOnce(() => new Promise((resolve) => { finishCurrent = resolve }))
      render(<KubecodeApp api={settingsApi({ runtimeStatus })} />)

      fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))
      fireEvent.click(screen.getByRole('button', { name: 'Agents' }))
      expect(within(screen.getByTestId('runtime-status-panel')).getByRole('status'))
        .toHaveTextContent('Loading Runtime status')
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))

      await act(async () => {
        if (outcome === 'success') {
          finishStale?.({
            active_actor_count: 91,
            idle_actor_count: 92,
            warm_actor_limit: 93,
            latest_workspace_event_cursor: 94,
            workspace_event_delivery_available: true,
          })
        } else {
          failStale?.(new Error('stale failure'))
        }
      })

      fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
      fireEvent.click(screen.getByRole('button', { name: 'Agents' }))
      expect(within(screen.getByTestId('runtime-status-panel')).getByRole('status'))
        .toHaveTextContent('Loading Runtime status')
      expect(screen.queryByText('91')).not.toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()

      await act(async () => finishCurrent?.({
        active_actor_count: 1,
        idle_actor_count: 2,
        warm_actor_limit: 3,
        latest_workspace_event_cursor: 4,
        workspace_event_delivery_available: true,
      }))
      const panel = screen.getByTestId('runtime-status-panel')
      expect(within(panel).getByText('1')).toBeInTheDocument()
      expect(within(panel).getByText('2')).toBeInTheDocument()
      expect(within(panel).getByText('3')).toBeInTheDocument()
      expect(runtimeStatus).toHaveBeenCalledTimes(2)
    },
  )

  it('offers a refresh after a Runtime status error', async () => {
    const runtimeStatus = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        active_actor_count: 1,
        idle_actor_count: 0,
        warm_actor_limit: 4,
        latest_workspace_event_cursor: 1,
        workspace_event_delivery_available: true,
      })
    render(<KubecodeApp api={settingsApi({ runtimeStatus })} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Agents' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Runtime status could not be loaded')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Runtime status' }))
    expect(await screen.findByText('Warm limit')).toBeInTheDocument()
  })

  it.each([
    ['delivery unavailable', settingsApi({ runtimeStatus: vi.fn().mockResolvedValue({
      active_actor_count: 8,
      idle_actor_count: 9,
      warm_actor_limit: 10,
      latest_workspace_event_cursor: 11,
      workspace_event_delivery_available: false,
    }) })],
    ['endpoint unavailable', settingsApi({ runtimeStatus: undefined })],
  ])('shows Runtime status as unavailable when %s', async (_case, api) => {
    render(<KubecodeApp api={api} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Agents' }))
    expect(await screen.findByText('Runtime status is unavailable.')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-status-panel')).not.toHaveTextContent('10')
  })

  it('surfaces running and stuck Agent sessions on their project icons', async () => {
    const api = {
      listProjects: vi.fn().mockResolvedValue([
        { id: 'project-running', name: 'Running', path: '/srv/running' },
        { id: 'project-stuck', name: 'Stuck', path: '/srv/stuck' },
      ]),
      listAgents: vi.fn().mockResolvedValue([]),
      listEntries: vi.fn().mockResolvedValue([]),
      listTerminals: vi.fn().mockResolvedValue([]),
      listConversations: vi.fn().mockResolvedValue([]),
      listProjectRuns: vi.fn().mockImplementation((projectId: string) => Promise.resolve([{
        id: `run-${projectId}`,
        conversation_id: `session-${projectId}`,
        project_id: projectId,
        message: 'Work',
        status: projectId === 'project-running' ? 'running' : 'waiting_permission',
        permission_mode: 'safe',
        error: null,
      }])),
      gitStatus: vi.fn().mockResolvedValue({ is_repository: false, branch: null, files: [] }),
    } as unknown as KubecodeApi

    render(<KubecodeApp api={api} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Running' })).toHaveAttribute('data-session-status', 'running')
      expect(screen.getByRole('button', { name: 'Stuck' })).toHaveAttribute('data-session-status', 'stuck')
    })
  })

  it('updates project activity from the global workspace event stream', async () => {
    const originalEventSource = globalThis.EventSource
    class ActivityEventSource {
      static current: ActivityEventSource | null = null
      onerror: ((event: Event) => void) | null = null
      private listener: ((event: MessageEvent<string>) => void) | null = null

      constructor() { ActivityEventSource.current = this }
      addEventListener(_type: string, listener: EventListener) {
        this.listener = listener as (event: MessageEvent<string>) => void
      }
      close() {}
      emit(event: unknown) {
        this.listener?.(new MessageEvent('workspace_event', { data: JSON.stringify(event) }))
      }
    }
    globalThis.EventSource = ActivityEventSource as unknown as typeof EventSource
    const api = {
      listProjects: vi.fn().mockResolvedValue([
        { id: 'project-live', name: 'Live', path: '/srv/live' },
      ]),
      listAgents: vi.fn().mockResolvedValue([]),
      listEntries: vi.fn().mockResolvedValue([]),
      listTerminals: vi.fn().mockResolvedValue([]),
      listConversations: vi.fn().mockResolvedValue([]),
      listProjectRuns: vi.fn().mockResolvedValue([]),
      gitStatus: vi.fn().mockResolvedValue({ is_repository: false, branch: null, files: [] }),
      workspaceEventStreamUrl: vi.fn().mockReturnValue('/events'),
    } as unknown as KubecodeApi

    try {
      render(<KubecodeApp api={api} />)
      const button = await screen.findByRole('button', { name: 'Live' })
      act(() => ActivityEventSource.current?.emit({
        id: 1,
        kind: 'run_started',
        project_id: 'project-live',
        conversation_id: 'session-live',
        run_id: 'run-live',
        payload: {},
        created_at: 'now',
      }))
      await waitFor(() => expect(button).toHaveAttribute('data-session-status', 'running'))

      act(() => ActivityEventSource.current?.emit({
        id: 2,
        kind: 'permission_requested',
        project_id: 'project-live',
        conversation_id: 'session-live',
        run_id: 'run-live',
        payload: {},
        created_at: 'now',
      }))
      await waitFor(() => expect(button).toHaveAttribute('data-session-status', 'stuck'))
    } finally {
      globalThis.EventSource = originalEventSource
    }
  })

  it('reconciles a 100-event workspace burst once per affected resource type', async () => {
    const originalEventSource = globalThis.EventSource
    class BurstEventSource {
      static current: BurstEventSource | null = null
      onerror: ((event: Event) => void) | null = null
      private listener: ((event: MessageEvent<string>) => void) | null = null

      constructor() { BurstEventSource.current = this }
      addEventListener(_type: string, listener: EventListener) {
        this.listener = listener as (event: MessageEvent<string>) => void
      }
      close() {}
      emit(event: unknown) {
        this.listener?.(new MessageEvent('workspace_event', { data: JSON.stringify(event) }))
      }
    }
    globalThis.EventSource = BurstEventSource as unknown as typeof EventSource
    const listSessions = vi.fn().mockResolvedValue([])
    const listConversations = vi.fn().mockResolvedValue([])
    const listTeams = vi.fn().mockResolvedValue([])
    const listTerminals = vi.fn().mockResolvedValue([])
    const closeTerminal = vi.fn().mockResolvedValue(undefined)
    const api = {
      listProjects: vi.fn().mockResolvedValue([
        { id: 'project-1', name: 'Demo', path: '/demo', workspaces_enabled: false },
      ]),
      listAgents: vi.fn().mockResolvedValue([]),
      listEntries: vi.fn().mockResolvedValue([]),
      listSessions,
      listConversations,
      listTeams,
      listTerminals,
      closeTerminal,
      listProjectRuns: vi.fn().mockResolvedValue([]),
      workspaceEventCursor: vi.fn().mockResolvedValue(0),
      workspaceEventStreamUrl: vi.fn().mockReturnValue('/events'),
      gitStatus: vi.fn().mockResolvedValue({ is_repository: false, branch: null, files: [] }),
    } as unknown as KubecodeApi

    try {
      render(<KubecodeApp api={api} />)
      await waitFor(() => {
        expect(listSessions).toHaveBeenCalledTimes(1)
        expect(listConversations).toHaveBeenCalledTimes(1)
        expect(listTeams).toHaveBeenCalledTimes(1)
        expect(listTerminals).toHaveBeenCalledTimes(1)
        expect(BurstEventSource.current).not.toBeNull()
      })

      act(() => {
        for (let id = 100; id >= 1; id -= 1) {
          const kinds = ['session_updated', 'team_task_updated', 'terminal_exited', 'run_started']
          const kind = kinds[id % kinds.length]
          BurstEventSource.current?.emit({
            id,
            kind,
            project_id: 'project-1',
            conversation_id: 'session-1',
            run_id: 'run-1',
            payload: kind === 'terminal_exited'
              ? { terminal_id: 'terminal-1', exit_code: 0, signal: null }
              : {},
            created_at: 'now',
          })
        }
      })

      await waitFor(() => {
        expect(listSessions).toHaveBeenCalledTimes(2)
        expect(listConversations).toHaveBeenCalledTimes(2)
        expect(listTeams).toHaveBeenCalledTimes(2)
        expect(listTerminals).toHaveBeenCalledTimes(2)
        expect(closeTerminal).toHaveBeenCalledTimes(1)
      })
      await new Promise((resolve) => window.setTimeout(resolve, 20))
      expect(listSessions).toHaveBeenCalledTimes(2)
      expect(listConversations).toHaveBeenCalledTimes(2)
      expect(listTeams).toHaveBeenCalledTimes(2)
      expect(listTerminals).toHaveBeenCalledTimes(2)
      expect(closeTerminal).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.EventSource = originalEventSource
    }
  })

  it('does not commit an event reconciliation response after the active Project changes', async () => {
    const originalEventSource = globalThis.EventSource
    class ProjectEventSource {
      static current: ProjectEventSource | null = null
      onerror: ((event: Event) => void) | null = null
      private listener: ((event: MessageEvent<string>) => void) | null = null

      constructor() { ProjectEventSource.current = this }
      addEventListener(_type: string, listener: EventListener) {
        this.listener = listener as (event: MessageEvent<string>) => void
      }
      close() {}
      emit(event: unknown) {
        this.listener?.(new MessageEvent('workspace_event', { data: JSON.stringify(event) }))
      }
    }
    globalThis.EventSource = ProjectEventSource as unknown as typeof EventSource
    const firstSession = {
      id: 'session-first',
      project_id: 'project-1',
      agent_id: 'codex' as const,
      provider_session_id: null,
      title: 'First Project session',
      manual_title: null,
      agent_title: null,
    }
    const staleSession = { ...firstSession, id: 'session-stale', title: 'Stale Project session' }
    const secondSession = {
      ...firstSession,
      id: 'session-second',
      project_id: 'project-2',
      title: 'Second Project session',
    }
    let resolveStale: ((sessions: typeof firstSession[]) => void) | undefined
    const staleResponse = new Promise<typeof firstSession[]>((resolve) => { resolveStale = resolve })
    let firstProjectCalls = 0
    const listConversations = vi.fn().mockImplementation((nextProjectId: string) => {
      if (nextProjectId === 'project-2') return Promise.resolve([secondSession])
      firstProjectCalls += 1
      return firstProjectCalls === 1 ? Promise.resolve([firstSession]) : staleResponse
    })
    const api = {
      listProjects: vi.fn().mockResolvedValue([
        { id: 'project-1', name: 'First', path: '/first' },
        { id: 'project-2', name: 'Second', path: '/second' },
      ]),
      listAgents: vi.fn().mockResolvedValue([]),
      listEntries: vi.fn().mockResolvedValue([]),
      listConversations,
      listTerminals: vi.fn().mockResolvedValue([]),
      listTeams: vi.fn().mockResolvedValue([]),
      listProjectRuns: vi.fn().mockResolvedValue([]),
      workspaceEventCursor: vi.fn().mockResolvedValue(0),
      workspaceEventStreamUrl: vi.fn().mockReturnValue('/events'),
      gitStatus: vi.fn().mockResolvedValue({ is_repository: false, branch: null, files: [] }),
    } as unknown as KubecodeApi

    try {
      render(<KubecodeApp api={api} />)
      expect(await screen.findByRole('button', { name: 'First Project session' })).toBeInTheDocument()
      await waitFor(() => expect(ProjectEventSource.current).not.toBeNull())

      act(() => ProjectEventSource.current?.emit({
        id: 1,
        kind: 'session_updated',
        project_id: 'project-1',
        conversation_id: 'session-first',
        run_id: null,
        payload: {},
        created_at: 'now',
      }))
      await waitFor(() => expect(listConversations).toHaveBeenCalledTimes(2))

      fireEvent.click(screen.getByRole('button', { name: 'Second' }))
      expect(await screen.findByRole('button', { name: 'Second Project session' })).toBeInTheDocument()
      await act(async () => resolveStale?.([staleSession]))

      expect(screen.getByRole('button', { name: 'Second Project session' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Stale Project session' })).not.toBeInTheDocument()
    } finally {
      globalThis.EventSource = originalEventSource
    }
  })

  it('clears the workspace connection warning after the event stream reconnects', async () => {
    const originalEventSource = globalThis.EventSource
    class ReconnectingEventSource {
      static current: ReconnectingEventSource | null = null
      onerror: ((event: Event) => void) | null = null
      onopen: ((event: Event) => void) | null = null

      constructor() { ReconnectingEventSource.current = this }
      addEventListener() {}
      close() {}
    }
    globalThis.EventSource = ReconnectingEventSource as unknown as typeof EventSource
    const api = {
      listProjects: vi.fn().mockResolvedValue([]),
      listAgents: vi.fn().mockResolvedValue([]),
      workspaceEventStreamUrl: vi.fn().mockReturnValue('/events'),
    } as unknown as KubecodeApi

    try {
      render(<KubecodeApp api={api} />)
      await waitFor(() => expect(ReconnectingEventSource.current).not.toBeNull())

      act(() => ReconnectingEventSource.current?.onerror?.(new Event('error')))
      expect(screen.getByRole('button', {
        name: 'Runtime connection: Reconnecting',
      })).toBeInTheDocument()

      act(() => ReconnectingEventSource.current?.onopen?.(new Event('open')))
      await screen.findByRole('button', { name: 'Runtime connection: Live' })
    } finally {
      globalThis.EventSource = originalEventSource
    }
  })

  it('runs one complete active-Project reconciliation for repeated reconnect opens', async () => {
    const originalEventSource = globalThis.EventSource
    class ReconnectingEventSource {
      static current: ReconnectingEventSource | null = null
      onerror: ((event: Event) => void) | null = null
      onopen: ((event: Event) => void) | null = null

      constructor() { ReconnectingEventSource.current = this }
      addEventListener() {}
      close() {}
    }
    globalThis.EventSource = ReconnectingEventSource as unknown as typeof EventSource
    let resolveTeams: ((teams: never[]) => void) | undefined
    const reconnectTeams = new Promise<never[]>((resolve) => { resolveTeams = resolve })
    const listSessions = vi.fn().mockResolvedValue([])
    const listConversations = vi.fn().mockResolvedValue([])
    const listTerminals = vi.fn().mockResolvedValue([])
    const listProjectRuns = vi.fn().mockResolvedValue([])
    const listTeams = vi.fn()
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(reconnectTeams)
    const api = {
      listProjects: vi.fn().mockResolvedValue([
        { id: 'project-1', name: 'Demo', path: '/demo', workspaces_enabled: false },
      ]),
      listAgents: vi.fn().mockResolvedValue([]),
      listEntries: vi.fn().mockResolvedValue([]),
      listTerminals,
      listConversations,
      listSessions,
      listTeams,
      listProjectRuns,
      workspaceEventCursor: vi.fn().mockResolvedValue(0),
      workspaceEventStreamUrl: vi.fn().mockReturnValue('/events'),
      gitStatus: vi.fn().mockResolvedValue({ is_repository: false, branch: null, files: [] }),
    } as unknown as KubecodeApi

    try {
      render(<KubecodeApp api={api} />)
      await waitFor(() => {
        expect(listSessions).toHaveBeenCalledTimes(1)
        expect(listConversations).toHaveBeenCalledTimes(1)
        expect(listTeams).toHaveBeenCalledTimes(1)
        expect(listTerminals).toHaveBeenCalledTimes(1)
        expect(listProjectRuns).toHaveBeenCalledTimes(1)
        expect(ReconnectingEventSource.current).not.toBeNull()
      })

      act(() => ReconnectingEventSource.current?.onopen?.(new Event('open')))
      act(() => ReconnectingEventSource.current?.onerror?.(new Event('error')))
      act(() => {
        ReconnectingEventSource.current?.onopen?.(new Event('open'))
        ReconnectingEventSource.current?.onopen?.(new Event('open'))
      })

      await waitFor(() => {
        expect(listSessions).toHaveBeenCalledTimes(2)
        expect(listConversations).toHaveBeenCalledTimes(2)
        expect(listTeams).toHaveBeenCalledTimes(2)
        expect(listTerminals).toHaveBeenCalledTimes(2)
        expect(listProjectRuns).toHaveBeenCalledTimes(2)
      })
      expect(screen.getByRole('button', {
        name: 'Runtime connection: Resynchronizing',
      })).toBeInTheDocument()
      await act(async () => resolveTeams?.([]))
      await screen.findByRole('button', { name: 'Runtime connection: Live' })
    } finally {
      globalThis.EventSource = originalEventSource
    }
  })

  it('does not commit a late sibling snapshot after reconnect reconciliation fails', async () => {
    const originalEventSource = globalThis.EventSource
    class ReconnectingEventSource {
      static current: ReconnectingEventSource | null = null
      onerror: ((event: Event) => void) | null = null
      onopen: ((event: Event) => void) | null = null

      constructor() { ReconnectingEventSource.current = this }
      addEventListener() {}
      close() {}
    }
    globalThis.EventSource = ReconnectingEventSource as unknown as typeof EventSource
    const initialSession = {
      id: 'session-initial',
      project_id: 'project-1',
      agent_id: 'codex' as const,
      provider_session_id: null,
      title: 'Initial session',
      manual_title: null,
      agent_title: 'Initial session',
    }
    const lateSession = {
      ...initialSession,
      id: 'session-late',
      title: 'Late failed snapshot',
      agent_title: 'Late failed snapshot',
    }
    let resolveLate: ((sessions: typeof initialSession[]) => void) | undefined
    const lateConversations = new Promise<typeof initialSession[]>((resolve) => {
      resolveLate = resolve
    })
    const listConversations = vi.fn()
      .mockResolvedValueOnce([initialSession])
      .mockReturnValueOnce(lateConversations)
    const listTeams = vi.fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('team recovery failed'))
    const api = {
      listProjects: vi.fn().mockResolvedValue([
        { id: 'project-1', name: 'Demo', path: '/demo', workspaces_enabled: false },
      ]),
      listAgents: vi.fn().mockResolvedValue([]),
      listEntries: vi.fn().mockResolvedValue([]),
      listTerminals: vi.fn().mockResolvedValue([]),
      listConversations,
      listSessions: vi.fn().mockResolvedValue([]),
      listTeams,
      listProjectRuns: vi.fn().mockResolvedValue([]),
      workspaceEventCursor: vi.fn().mockResolvedValue(0),
      workspaceEventStreamUrl: vi.fn().mockReturnValue('/events'),
      gitStatus: vi.fn().mockResolvedValue({ is_repository: false, branch: null, files: [] }),
    } as unknown as KubecodeApi

    try {
      render(<KubecodeApp api={api} />)
      expect(await screen.findByRole('button', { name: 'Initial session' })).toBeInTheDocument()
      await waitFor(() => expect(ReconnectingEventSource.current).not.toBeNull())

      act(() => ReconnectingEventSource.current?.onopen?.(new Event('open')))
      act(() => ReconnectingEventSource.current?.onerror?.(new Event('error')))
      act(() => ReconnectingEventSource.current?.onopen?.(new Event('open')))

      await waitFor(() => expect(listTeams).toHaveBeenCalledTimes(2))
      expect(screen.queryByRole('button', { name: 'Late failed snapshot' })).not.toBeInTheDocument()
      await act(async () => resolveLate?.([lateSession]))

      await waitFor(() => expect(screen.getByRole('status', {
        name: 'team recovery failed',
      })).toBeInTheDocument())
      expect(screen.getByRole('button', { name: 'Initial session' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Late failed snapshot' })).not.toBeInTheDocument()
    } finally {
      globalThis.EventSource = originalEventSource
    }
  })

  it('does not poll Team snapshots on an interval', async () => {
    const intervalSpy = vi.spyOn(window, 'setInterval')
    const listTeams = vi.fn().mockResolvedValue([])
    const api = {
      listProjects: vi.fn().mockResolvedValue([
        { id: 'project-1', name: 'Demo', path: '/demo', workspaces_enabled: false },
      ]),
      listAgents: vi.fn().mockResolvedValue([]),
      listEntries: vi.fn().mockResolvedValue([]),
      listTerminals: vi.fn().mockResolvedValue([]),
      listConversations: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue([]),
      listTeams,
      gitStatus: vi.fn().mockResolvedValue({ is_repository: false, branch: null, files: [] }),
    } as unknown as KubecodeApi

    try {
      render(<KubecodeApp api={api} />)
      await waitFor(() => expect(listTeams).toHaveBeenCalledTimes(1))
      expect(intervalSpy).not.toHaveBeenCalledWith(expect.any(Function), 3000)
    } finally {
      intervalSpy.mockRestore()
    }
  })

  it('hydrates Sessions and Teams when the Terminal snapshot fails', async () => {
    const api = {
      listProjects: vi.fn().mockResolvedValue([
        { id: 'project-1', name: 'Demo', path: '/demo', workspaces_enabled: false },
      ]),
      listAgents: vi.fn().mockResolvedValue([]),
      listEntries: vi.fn().mockResolvedValue([]),
      listTerminals: vi.fn().mockRejectedValue(new Error('terminal unavailable')),
      listConversations: vi.fn().mockResolvedValue([{
        id: 'session-1',
        agent_session_id: 'agent-session-1',
        project_id: 'project-1',
        agent_id: 'codex',
        provider_session_id: null,
        title: 'Persistent leader',
        manual_title: null,
        agent_title: 'Persistent leader',
        execution_mode: 'shared',
        workspace_path: null,
        recreated_context: false,
        team_id: 'team-1',
        team_role: 'leader',
      }]),
      listTeams: vi.fn().mockResolvedValue([]),
      gitStatus: vi.fn().mockResolvedValue({ is_repository: false, branch: null, files: [] }),
    } as unknown as KubecodeApi

    render(<KubecodeApp api={api} />)

    expect(await screen.findByRole(
      'button',
      { name: 'Persistent leader' },
      { timeout: 5_000 },
    )).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Persistent leader' })).toBeInTheDocument()
  })

  it('closes a terminal after a clean shell exit event', async () => {
    const originalEventSource = globalThis.EventSource
    class TerminalEventSource {
      static current: TerminalEventSource | null = null
      onerror: ((event: Event) => void) | null = null
      private listener: ((event: MessageEvent<string>) => void) | null = null

      constructor() { TerminalEventSource.current = this }
      addEventListener(_type: string, listener: EventListener) {
        this.listener = listener as (event: MessageEvent<string>) => void
      }
      close() {}
      emit(event: unknown) {
        this.listener?.(new MessageEvent('workspace_event', { data: JSON.stringify(event) }))
      }
    }
    globalThis.EventSource = TerminalEventSource as unknown as typeof EventSource
    const closeTerminal = vi.fn().mockResolvedValue(undefined)
    const api = {
      closeTerminal,
      listProjects: vi.fn().mockResolvedValue([{ id: 'project-1', name: 'Demo', path: '/demo' }]),
      listAgents: vi.fn().mockResolvedValue([]),
      listEntries: vi.fn().mockResolvedValue([]),
      listTerminals: vi.fn().mockResolvedValue([terminal('terminal-1')]),
      listConversations: vi.fn().mockResolvedValue([]),
      gitStatus: vi.fn().mockResolvedValue({ is_repository: false, branch: null, files: [] }),
      workspaceEventStreamUrl: vi.fn().mockReturnValue('/events'),
    } as unknown as KubecodeApi

    try {
      render(<KubecodeApp api={api} />)
      await screen.findByRole('button', { name: 'Demo' })
      act(() => TerminalEventSource.current?.emit({
        id: 1,
        kind: 'terminal_exited',
        project_id: 'project-1',
        conversation_id: null,
        run_id: null,
        payload: { terminal_id: 'terminal-1', status: 'exited', exit_code: 0, signal: null },
        created_at: 'now',
      }))

      await waitFor(() => expect(closeTerminal).toHaveBeenCalledWith('terminal-1'))
    } finally {
      globalThis.EventSource = originalEventSource
    }
  })

  it('preserves one clean terminal close across a superseded failed recovery', async () => {
    const originalEventSource = globalThis.EventSource
    class TerminalEventSource {
      static current: TerminalEventSource | null = null
      onerror: ((event: Event) => void) | null = null
      onopen: ((event: Event) => void) | null = null
      private listener: ((event: MessageEvent<string>) => void) | null = null

      constructor() { TerminalEventSource.current = this }
      addEventListener(_type: string, listener: EventListener) {
        this.listener = listener as (event: MessageEvent<string>) => void
      }
      close() {}
      emit(event: unknown) {
        this.listener?.(new MessageEvent('workspace_event', { data: JSON.stringify(event) }))
      }
    }
    globalThis.EventSource = TerminalEventSource as unknown as typeof EventSource
    let rejectHeld: ((reason?: unknown) => void) | undefined
    let resolveReplacement: ((teams: never[]) => void) | undefined
    const heldRecovery = new Promise<never[]>((_resolve, reject) => { rejectHeld = reject })
    const replacementRecovery = new Promise<never[]>((resolve) => { resolveReplacement = resolve })
    const closeTerminal = vi.fn().mockResolvedValue(undefined)
    const listTerminals = vi.fn()
      .mockResolvedValueOnce([terminal('terminal-1')])
      .mockResolvedValueOnce([terminal('terminal-1')])
      .mockResolvedValueOnce([terminal('terminal-1')])
      .mockRejectedValueOnce(new Error('terminal refresh failed'))
      .mockResolvedValue([terminal('terminal-1')])
    const listTeams = vi.fn()
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(heldRecovery)
      .mockReturnValueOnce(replacementRecovery)
      .mockResolvedValue([])
    const api = {
      closeTerminal,
      listProjects: vi.fn().mockResolvedValue([{ id: 'project-1', name: 'Demo', path: '/demo' }]),
      listAgents: vi.fn().mockResolvedValue([]),
      listEntries: vi.fn().mockResolvedValue([]),
      listTerminals,
      listConversations: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue([]),
      listTeams,
      listProjectRuns: vi.fn().mockResolvedValue([]),
      workspaceEventCursor: vi.fn().mockResolvedValue(0),
      workspaceEventStreamUrl: vi.fn().mockReturnValue('/events'),
      gitStatus: vi.fn().mockResolvedValue({ is_repository: false, branch: null, files: [] }),
    } as unknown as KubecodeApi

    try {
      render(<KubecodeApp api={api} />)
      await waitFor(() => {
        expect(listTeams).toHaveBeenCalledTimes(1)
        expect(TerminalEventSource.current).not.toBeNull()
      })
      act(() => TerminalEventSource.current?.onopen?.(new Event('open')))
      act(() => TerminalEventSource.current?.onerror?.(new Event('error')))
      act(() => TerminalEventSource.current?.onopen?.(new Event('open')))
      await waitFor(() => expect(listTeams).toHaveBeenCalledTimes(2))

      act(() => TerminalEventSource.current?.emit({
        id: 1,
        kind: 'terminal_exited',
        project_id: 'project-1',
        conversation_id: null,
        run_id: null,
        payload: { terminal_id: 'terminal-1', status: 'exited', exit_code: 0, signal: null },
        created_at: 'now',
      }))
      await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
      expect(closeTerminal).not.toHaveBeenCalled()

      act(() => TerminalEventSource.current?.onerror?.(new Event('error')))
      act(() => TerminalEventSource.current?.onopen?.(new Event('open')))
      await waitFor(() => expect(listTeams).toHaveBeenCalledTimes(3))
      act(() => TerminalEventSource.current?.emit({
        id: 2,
        kind: 'terminal_updated',
        project_id: 'project-1',
        conversation_id: null,
        run_id: null,
        payload: { terminal_id: 'terminal-1' },
        created_at: 'now',
      }))
      await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
      await act(async () => resolveReplacement?.([]))
      await waitFor(() => expect(closeTerminal).toHaveBeenCalledTimes(1))
      await act(async () => rejectHeld?.(new Error('superseded recovery failed')))

      await waitFor(() => expect(listTerminals).toHaveBeenCalledTimes(4))
      await act(async () => Promise.resolve())
      act(() => TerminalEventSource.current?.onopen?.(new Event('open')))

      await waitFor(() => expect(listTeams).toHaveBeenCalledTimes(4))
      expect(closeTerminal).toHaveBeenCalledWith('terminal-1')
      expect(closeTerminal).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.EventSource = originalEventSource
    }
  })

  it('creates sessions only from available agents and resizes session, context, and terminal panes', async () => {
    const api = {
      listProjects: vi.fn().mockResolvedValue([
        { id: 'project-1', name: 'Demo', path: 'demo' },
      ]),
      listAgents: vi.fn().mockResolvedValue([
        { id: 'codex', available: true, version: 'test', executable: 'codex', error: null },
        { id: 'claude_code', available: false, version: null, executable: 'claude', error: 'missing' },
        { id: 'opencode', available: true, version: 'test', executable: 'opencode', error: null },
      ]),
      listEntries: vi.fn().mockResolvedValue([]),
      listTerminals: vi.fn().mockResolvedValue([terminal('terminal-1')]),
      listConversations: vi.fn().mockResolvedValue([]),
      gitStatus: vi.fn().mockResolvedValue({ is_repository: false, branch: null, files: [] }),
    } as unknown as KubecodeApi
    const { container } = render(<KubecodeApp api={api} />)

    expect(await screen.findByRole('button', { name: 'Demo' })).toBeInTheDocument()
    expect(screen.getByTestId('agent-session-workspace')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(screen.getByRole('button', { name: 'Start new' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Team' }))
    expect(screen.getByRole('button', { name: 'Team' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('textbox', { name: 'Team name' })).not.toBeRequired()
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Team name' }), {
      target: { value: 'Research team' },
    })
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled()
    fireEvent.click(screen.getByRole('combobox', { name: 'Agent' }))
    const claudeOption = screen.getByRole('option', { name: /Claude Code/ })
    expect(claudeOption).toBeInTheDocument()
    expect(claudeOption).toHaveAttribute('data-disabled')
    expect(document.querySelector('img[src="./ai-agent-icons/claude-code.svg"]')).toBeInTheDocument()
    expect(document.querySelector('img[src="./ai-agent-icons/opencode.svg"]')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect((container.querySelector('.kubecode-terminal-pane') as HTMLElement).style.height).toBe('0px')
    fireEvent.click(screen.getByRole('button', { name: 'Toggle terminal' }))
    expect(screen.getByRole('button', { name: 'Toggle terminal' })).toHaveAttribute('aria-pressed', 'true')
    const handles = container.querySelectorAll('.cursor-col-resize')
    expect(handles).toHaveLength(2)
    const terminalHandle = container.querySelector('.cursor-row-resize') as HTMLElement
    expect(terminalHandle).toBeInTheDocument()

    const sidebar = container.querySelector('.kubecode-session-sidebar') as HTMLElement
    expect(sidebar.style.width).toBe('280px')
    fireEvent.mouseDown(handles[0], { clientX: 328 })
    fireEvent.mouseMove(document, { clientX: 368 })
    fireEvent.mouseUp(document)
    expect(sidebar.style.width).toBe('320px')

    const contextPane = screen.getByTestId('context-workbench')
    expect(contextPane.style.width).toBe('440px')
    fireEvent.mouseDown(handles[1], { clientX: 1100 })
    fireEvent.mouseMove(document, { clientX: 1060 })
    fireEvent.mouseUp(document)
    expect(contextPane.style.width).toBe('480px')

    const terminalPane = container.querySelector('.kubecode-terminal-pane') as HTMLElement
    expect(terminalPane.style.height).toBe('260px')
    fireEvent.mouseDown(terminalHandle, { clientY: 600 })
    fireEvent.mouseMove(document, { clientY: 560 })
    fireEvent.mouseUp(document)
    expect(terminalPane.style.height).toBe('300px')

    expect(screen.getByTestId('agent-session-workspace')).toBeVisible()
  })

  it('uses mutually exclusive overlay side panels on a narrow workbench', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: query === '(max-width: 980px)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })))
    const api = {
      listProjects: vi.fn().mockResolvedValue([{ id: 'project-1', name: 'Demo', path: '/demo' }]),
      listAgents: vi.fn().mockResolvedValue([]),
      listEntries: vi.fn().mockResolvedValue([]),
      listTerminals: vi.fn().mockResolvedValue([]),
      listConversations: vi.fn().mockResolvedValue([]),
      gitStatus: vi.fn().mockResolvedValue({ is_repository: false, branch: null, files: [] }),
    } as unknown as KubecodeApi
    const { container } = render(<KubecodeApp api={api} />)

    await screen.findByRole('button', { name: 'Demo' })
    expect(container.querySelector('.kubecode-workspace')).toHaveAttribute('data-narrow', 'true')
    expect(screen.getByRole('button', { name: 'Close side panels' })).toBeInTheDocument()

    const contextToggle = screen.getByRole('button', { name: 'Toggle context panel' })
    fireEvent.click(contextToggle)
    fireEvent.click(contextToggle)
    expect(contextToggle).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Toggle sessions' })).toHaveAttribute('aria-pressed', 'false')

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(contextToggle).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('button', { name: 'Close side panels' })).not.toBeInTheDocument()
  })

  it('restores the saved pane layout for a project', async () => {
    localStorage.setItem('kubecode:layout:project-1', JSON.stringify({
      contextOpen: true,
      contextWidth: 612,
      sessionSidebarOpen: true,
      sessionSidebarWidth: 357,
      terminalHeight: 389,
      terminalOpen: true,
    }))
    const api = {
      listProjects: vi.fn().mockResolvedValue([{ id: 'project-1', name: 'Demo', path: 'demo' }]),
      listAgents: vi.fn().mockResolvedValue([]),
      listEntries: vi.fn().mockResolvedValue([]),
      listTerminals: vi.fn().mockResolvedValue([terminal('terminal-1')]),
      listConversations: vi.fn().mockResolvedValue([]),
      gitStatus: vi.fn().mockResolvedValue({ is_repository: false, branch: null, files: [] }),
    } as unknown as KubecodeApi
    const { container } = render(<KubecodeApp api={api} />)

    expect(await screen.findByRole('button', { name: 'Demo' })).toBeInTheDocument()
    expect((container.querySelector('.kubecode-session-sidebar') as HTMLElement).style.width).toBe('357px')
    expect(screen.getByTestId('context-workbench').style.width).toBe('612px')
    expect((container.querySelector('.kubecode-terminal-pane') as HTMLElement).style.height).toBe('389px')
  })

  it('focuses global Project and Session search with the platform shortcut', async () => {
    const api = {
      listProjects: vi.fn().mockResolvedValue([{ id: 'project-1', name: 'Demo', path: '/demo' }]),
      listAgents: vi.fn().mockResolvedValue([]),
      listEntries: vi.fn().mockResolvedValue([]),
      listTerminals: vi.fn().mockResolvedValue([]),
      listConversations: vi.fn().mockResolvedValue([]),
      gitStatus: vi.fn().mockResolvedValue({ is_repository: false, branch: null, files: [] }),
    } as unknown as KubecodeApi

    render(<KubecodeApp api={api} />)
    const search = await screen.findByRole('textbox', { name: 'Search sessions' })
    fireEvent.keyDown(document, { key: 'k', metaKey: true })
    expect(search).toHaveFocus()
  })

  it('opens the global palette without stealing quick open and runs host actions locally', async () => {
    const startRun = vi.fn()
    const dispatchAcpCommand = vi.fn()
    const api = {
      listProjects: vi.fn().mockResolvedValue([{ id: 'project-1', name: 'Demo', path: '/demo' }]),
      listAgents: vi.fn().mockResolvedValue([]),
      listEntries: vi.fn().mockResolvedValue([]),
      listTerminals: vi.fn().mockResolvedValue([]),
      listConversations: vi.fn().mockResolvedValue([]),
      gitStatus: vi.fn().mockResolvedValue({ is_repository: false, branch: null, files: [] }),
      startRun,
      dispatchAcpCommand,
    } as unknown as KubecodeApi

    render(<KubecodeApp api={api} />)
    const search = await screen.findByRole('textbox', { name: 'Search sessions' })
    search.focus()
    fireEvent.keyDown(document, { key: 'p', ctrlKey: true, shiftKey: true })

    expect(await screen.findByRole('dialog', { name: 'Command Palette' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Search files' })).not.toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(search).toHaveFocus())

    fireEvent.keyDown(document, { key: 'p', ctrlKey: true, shiftKey: true })
    fireEvent.click(await screen.findByRole('option', { name: 'Settings' }))
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'p', ctrlKey: true, shiftKey: true })
    expect(screen.queryByRole('dialog', { name: 'Command Palette' })).not.toBeInTheDocument()
    expect(startRun).not.toHaveBeenCalled()
    expect(dispatchAcpCommand).not.toHaveBeenCalled()
  })

  it('waits for the selected Project terminal list before auto-creating a terminal', async () => {
    for (const projectId of ['project-1', 'project-2']) {
      localStorage.setItem(`kubecode:layout:${projectId}`, JSON.stringify({ terminalOpen: true }))
    }
    let resolveSecondProject: ((terminals: TerminalInfo[]) => void) | undefined
    const secondProjectTerminals = new Promise<TerminalInfo[]>((resolve) => {
      resolveSecondProject = resolve
    })
    const createTerminal = vi.fn().mockResolvedValue(terminal('unexpected-terminal'))
    const api = {
      createTerminal,
      listProjects: vi.fn().mockResolvedValue([
        { id: 'project-1', name: 'First', path: '/first' },
        { id: 'project-2', name: 'Second', path: '/second' },
      ]),
      listAgents: vi.fn().mockResolvedValue([]),
      listEntries: vi.fn().mockResolvedValue([]),
      listTerminals: vi.fn().mockImplementation((projectId: string) => (
        projectId === 'project-1'
          ? Promise.resolve([terminal('first-terminal')])
          : secondProjectTerminals
      )),
      listConversations: vi.fn().mockResolvedValue([]),
      gitStatus: vi.fn().mockResolvedValue({ is_repository: false, branch: null, files: [] }),
    } as unknown as KubecodeApi

    render(<KubecodeApp api={api} />)
    expect(await screen.findByTestId('terminal-first-terminal')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Second' }))
    await waitFor(() => expect(api.listTerminals).toHaveBeenCalledWith('project-2'))
    expect(createTerminal).not.toHaveBeenCalled()

    await act(async () => resolveSecondProject?.([terminal('second-terminal')]))
    expect(await screen.findByTestId('terminal-second-terminal')).toBeInTheDocument()
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('registers projects by full path and browses server directories when importing', async () => {
    const api = {
      listProjects: vi.fn().mockResolvedValue([]),
      listAgents: vi.fn().mockResolvedValue([]),
      listDirectories: vi.fn().mockResolvedValue({
        path: '/srv/projects',
        parent: '/srv',
        entries: [{ name: 'demo', path: '/srv/projects/demo', hidden: false }],
      }),
    } as unknown as KubecodeApi
    render(<KubecodeApp api={api} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add project' }))
    expect(screen.queryByRole('textbox', { name: 'Project name' })).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Full path on this server' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Import project' }))
    expect(await screen.findByRole('option', { name: /demo/ })).toBeInTheDocument()
    expect(api.listDirectories).toHaveBeenCalledWith(undefined)
  })

  it('shows functional session actions and preserves an Agent title separately', async () => {
    const deleteConversation = vi.fn().mockResolvedValue(undefined)
    const api = {
      listProjects: vi.fn().mockResolvedValue([{ id: 'project-1', name: 'Demo', path: '/srv/demo' }]),
      listAgents: vi.fn().mockResolvedValue([
        { id: 'codex', available: true, version: 'test', executable: 'codex', error: null },
      ]),
      listEntries: vi.fn().mockResolvedValue([]),
      listTerminals: vi.fn().mockResolvedValue([]),
      listConversations: vi.fn().mockResolvedValue([{
        id: 'session-1',
        project_id: 'project-1',
        agent_id: 'codex',
        provider_session_id: 'native-1',
        title: 'Agent title',
        manual_title: null,
        agent_title: 'Agent title',
      }]),
      listRuns: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue({
        capabilities: { sessionCapabilities: { delete: {} } },
        available_commands: null,
        current_mode: null,
        config_options: null,
        plan: null,
        usage: null,
      }),
      deleteConversation,
      gitStatus: vi.fn().mockResolvedValue({ is_repository: false, branch: null, files: [] }),
    } as unknown as KubecodeApi
    render(<KubecodeApp api={api} />)

    await waitFor(() => expect(screen.getAllByText('Agent title')).toHaveLength(2))
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Session actions' }), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    })
    expect(await screen.findByText('Rename session')).toBeInTheDocument()
    expect(screen.getByText('Delete')).toBeInTheDocument()
    expect(screen.queryByText('Remove from Kubecode')).not.toBeInTheDocument()
    expect(screen.queryByText('Delete from Agent')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Delete'))
    await waitFor(() => expect(deleteConversation).toHaveBeenCalledWith('session-1'))
  })

  it('removes the active project registration from the project menu', async () => {
    const unregisterProject = vi.fn().mockResolvedValue(undefined)
    const api = {
      listProjects: vi.fn().mockResolvedValue([
        { id: 'project-1', name: 'Demo', path: '/srv/demo' },
        { id: 'project-2', name: 'Next', path: '/srv/next' },
      ]),
      listAgents: vi.fn().mockResolvedValue([]),
      listEntries: vi.fn().mockResolvedValue([]),
      listTerminals: vi.fn().mockResolvedValue([]),
      listConversations: vi.fn().mockResolvedValue([]),
      listProjectRuns: vi.fn().mockResolvedValue([]),
      unregisterProject,
      gitStatus: vi.fn().mockResolvedValue({ is_repository: false, branch: null, files: [] }),
    } as unknown as KubecodeApi
    render(<KubecodeApp api={api} />)

    await screen.findByRole('button', { name: 'Demo' })
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Actions for project Demo' }), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    })
    fireEvent.click(await screen.findByText('Delete'))

    await waitFor(() => expect(unregisterProject).toHaveBeenCalledWith('project-1'))
    expect(screen.queryByRole('button', { name: 'Demo' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next' })).toHaveAttribute('data-active', 'true')
  })

  it('enables Workspaces for a project from its menu', async () => {
    const setProjectWorkspacesEnabled = vi.fn().mockResolvedValue({
      id: 'project-1',
      name: 'Demo',
      path: '/srv/demo',
      workspaces_enabled: true,
    })
    const api = {
      listProjects: vi.fn().mockResolvedValue([
        { id: 'project-1', name: 'Demo', path: '/srv/demo', workspaces_enabled: false },
      ]),
      listAgents: vi.fn().mockResolvedValue([]),
      listEntries: vi.fn().mockResolvedValue([]),
      listTerminals: vi.fn().mockResolvedValue([]),
      listConversations: vi.fn().mockResolvedValue([]),
      listProjectRuns: vi.fn().mockResolvedValue([]),
      setProjectWorkspacesEnabled,
      gitStatus: vi.fn().mockResolvedValue({ is_repository: false, branch: null, files: [] }),
    } as unknown as KubecodeApi
    render(<KubecodeApp api={api} />)

    await screen.findByRole('button', { name: 'Demo' })
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Actions for project Demo' }), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    })
    fireEvent.click(await screen.findByText('Enable Workspaces'))

    await waitFor(() => expect(setProjectWorkspacesEnabled).toHaveBeenCalledWith('project-1', true))
    expect(screen.getByRole('button', { name: 'Demo' })).toHaveAttribute(
      'data-workspaces-enabled',
      'true',
    )
  })

  it('renders and resolves an ACP elicitation form from the active Agent run', async () => {
    const resolveElicitation = vi.fn().mockResolvedValue(undefined)
    const api = {
      listProjects: vi.fn().mockResolvedValue([{ id: 'project-1', name: 'Demo', path: '/srv/demo' }]),
      listAgents: vi.fn().mockResolvedValue([
        { id: 'codex', available: true, version: 'test', executable: 'codex', error: null },
      ]),
      listEntries: vi.fn().mockResolvedValue([]),
      listTerminals: vi.fn().mockResolvedValue([]),
      listConversations: vi.fn().mockResolvedValue([{
        id: 'session-1',
        project_id: 'project-1',
        agent_id: 'codex',
        provider_session_id: 'native-1',
        title: 'Session',
        manual_title: null,
        agent_title: null,
      }]),
      listRuns: vi.fn().mockResolvedValue([{
        id: 'run-1',
        conversation_id: 'session-1',
        project_id: 'project-1',
        message: 'Build the feature',
        status: 'running',
        permission_mode: 'safe',
        error: null,
      }]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([{
        run_id: 'run-1',
        seq: 1,
        kind: 'elicitation_requested',
        created_at: '2026-07-15T00:00:00Z',
        payload: {
          request_id: 'question-1',
          message: 'Which behavior should I implement?',
          requestedSchema: {
            type: 'object',
            required: ['goal'],
            properties: {
              goal: { type: 'string', title: 'Goal' },
              includeTests: { type: 'boolean', title: 'Include tests', default: true },
            },
          },
        },
      }]),
      getSessionState: vi.fn().mockResolvedValue({
        capabilities: null,
        available_commands: null,
        current_mode: null,
        config_options: null,
        plan: null,
        usage: null,
      }),
      resolveElicitation,
      gitStatus: vi.fn().mockResolvedValue({ is_repository: false, branch: null, files: [] }),
    } as unknown as KubecodeApi
    render(<KubecodeApp api={api} />)

    expect(await screen.findByText('Which behavior should I implement?')).toBeInTheDocument()
    const submit = screen.getByRole('button', { name: 'Submit answers' })
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Goal' }), { target: { value: 'Use native ACP' } })
    fireEvent.click(submit)

    await waitFor(() => expect(resolveElicitation).toHaveBeenCalledWith('question-1', {
      goal: 'Use native ACP',
      includeTests: true,
    }))
  })
})

function terminal(id: string): TerminalInfo {
  return {
    id,
    project_id: 'project-1',
    conversation_id: null,
    title: 'Terminal',
    kind: 'regular',
    cols: 100,
    rows: 28,
    status: 'running',
    exit_code: null,
    signal: null,
  }
}

function settingsApi(overrides: Record<string, unknown> = {}): KubecodeApi {
  return {
    listProjects: vi.fn().mockResolvedValue([]),
    listAgents: vi.fn().mockResolvedValue([]),
    listSessions: vi.fn().mockResolvedValue([]),
    listTeams: vi.fn().mockResolvedValue([]),
    workspaceEventStreamUrl: vi.fn().mockReturnValue('/events'),
    runtimeStatus: vi.fn().mockResolvedValue({
      active_actor_count: 0,
      idle_actor_count: 0,
      warm_actor_limit: 4,
      latest_workspace_event_cursor: 0,
      workspace_event_delivery_available: true,
    }),
    ...overrides,
  } as unknown as KubecodeApi
}
