import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

    render(<KubecodeApp api={api} />)

    expect(await screen.findByRole('button', { name: 'Demo' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New session' })).toBeInTheDocument()
    expect(screen.getByTestId('agent-session-workspace')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Toggle sessions' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Toggle terminal' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Toggle context panel' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('tab', { name: 'Changes' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('data-state', 'active')
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
      expect(button).toHaveAttribute('data-session-status', 'running')

      act(() => ActivityEventSource.current?.emit({
        id: 2,
        kind: 'permission_requested',
        project_id: 'project-live',
        conversation_id: 'session-live',
        run_id: 'run-live',
        payload: {},
        created_at: 'now',
      }))
      expect(button).toHaveAttribute('data-session-status', 'stuck')
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
      expect(screen.getByRole('status', {
        name: 'Workspace connection lost. Reconnecting…',
      })).toBeInTheDocument()

      act(() => ReconnectingEventSource.current?.onopen?.(new Event('open')))
      expect(screen.queryByRole('status', {
        name: 'Workspace connection lost. Reconnecting…',
      })).not.toBeInTheDocument()
    } finally {
      globalThis.EventSource = originalEventSource
    }
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
    expect(screen.getByRole('textbox', { name: 'Full path on this server' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Import project' }))
    expect(await screen.findByText('/srv/projects')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /demo/ })).toBeInTheDocument()
    expect(api.listDirectories).toHaveBeenCalledWith(undefined)
  })

  it('shows functional session actions and preserves an Agent title separately', async () => {
    const removeConversation = vi.fn().mockResolvedValue(undefined)
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
      removeConversation,
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
    await waitFor(() => expect(removeConversation).toHaveBeenCalledWith('session-1'))
    expect(removeConversation).not.toHaveBeenCalledWith('session-1', 'provider')
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
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Project actions' }), {
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
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Project actions' }), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    })
    fireEvent.click(await screen.findByText('Enable Workspaces'))

    await waitFor(() => expect(setProjectWorkspacesEnabled).toHaveBeenCalledWith('project-1', true))
    expect(screen.getByText('Workspaces enabled')).toBeInTheDocument()
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
    title: 'Terminal',
    kind: 'regular',
    cols: 100,
    rows: 28,
    status: 'running',
    exit_code: null,
    signal: null,
  }
}
