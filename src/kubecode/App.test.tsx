import { fireEvent, render, screen } from '@testing-library/react'
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
})
