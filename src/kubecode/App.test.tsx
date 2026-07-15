import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { KubecodeApp } from './App'
import type { KubecodeApi } from './api'

describe('Kubecode workspace', () => {
  beforeEach(() => localStorage.clear())

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
    expect(screen.getByRole('tab', { name: 'Review' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Files' })).toBeInTheDocument()
    expect(screen.queryByText('Select a file to start editing')).not.toBeInTheDocument()
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
      listTerminals: vi.fn().mockResolvedValue([]),
      listConversations: vi.fn().mockResolvedValue([]),
      gitStatus: vi.fn().mockResolvedValue({ is_repository: false, branch: null, files: [] }),
    } as unknown as KubecodeApi
    const { container } = render(<KubecodeApp api={api} />)

    expect(await screen.findByRole('button', { name: 'Demo' })).toBeInTheDocument()
    expect(screen.getByTestId('agent-session-workspace')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    fireEvent.click(screen.getByRole('combobox', { name: 'Agent' }))
    const claudeOption = screen.getByRole('option', { name: /Claude Code/ })
    expect(claudeOption).toBeInTheDocument()
    expect(claudeOption).toHaveAttribute('data-disabled')
    expect(document.querySelector('img[src="./ai-agent-icons/claude-code.svg"]')).toBeInTheDocument()
    expect(document.querySelector('img[src="./ai-agent-icons/opencode.svg"]')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.keyDown(document, { key: 'Escape' })
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
      listTerminals: vi.fn().mockResolvedValue([]),
      listConversations: vi.fn().mockResolvedValue([]),
      gitStatus: vi.fn().mockResolvedValue({ is_repository: false, branch: null, files: [] }),
    } as unknown as KubecodeApi
    const { container } = render(<KubecodeApp api={api} />)

    expect(await screen.findByRole('button', { name: 'Demo' })).toBeInTheDocument()
    expect((container.querySelector('.kubecode-session-sidebar') as HTMLElement).style.width).toBe('357px')
    expect(screen.getByTestId('context-workbench').style.width).toBe('612px')
    expect((container.querySelector('.kubecode-terminal-pane') as HTMLElement).style.height).toBe('389px')
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
    expect(screen.getByText('Remove from Kubecode')).toBeInTheDocument()
    expect(screen.getByText('Delete from Agent')).toBeInTheDocument()
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
