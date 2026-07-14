import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { KubecodeApp } from './App'
import type { KubecodeApi } from './api'

describe('Kubecode workspace', () => {
  it('shows registered projects and keeps the empty editor actionable', async () => {
    const api = {
      listProjects: vi.fn().mockResolvedValue([
        { id: 'project-1', name: 'Demo', path: 'demo' },
      ]),
      listAgents: vi.fn().mockResolvedValue([]),
      listEntries: vi.fn().mockResolvedValue([]),
      listTerminals: vi.fn().mockResolvedValue([]),
      listConversations: vi.fn().mockResolvedValue([]),
    } as unknown as KubecodeApi

    render(<KubecodeApp api={api} />)

    expect(await screen.findByRole('button', { name: 'Demo' })).toBeInTheDocument()
    expect(screen.getByText('Select a file to start editing')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'New file' })).toHaveLength(2)
  })

  it('keeps the Tolaria AI chrome and lets both sidebars resize', async () => {
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
    } as unknown as KubecodeApi
    const { container } = render(<KubecodeApp api={api} />)

    expect(await screen.findByTestId('ai-panel')).toBeInTheDocument()
    expect(screen.getByTestId('ai-permission-mode-toggle')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Safe' })).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: 'Vault Safe' })).not.toBeInTheDocument()
    expect(document.querySelectorAll('img[src="./ai-agent-icons/codex.svg"]').length)
      .toBeGreaterThanOrEqual(2)
    fireEvent.click(screen.getByRole('combobox', { name: 'Agent' }))
    const claudeOption = screen.getByRole('option', { name: /Claude Code/ })
    expect(claudeOption).toBeInTheDocument()
    expect(claudeOption).toHaveAttribute('data-disabled')
    expect(document.querySelector('img[src="./ai-agent-icons/claude-code.svg"]')).toBeInTheDocument()
    expect(document.querySelector('img[src="./ai-agent-icons/opencode.svg"]')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    const handles = container.querySelectorAll('.cursor-col-resize')
    expect(handles).toHaveLength(2)
    const terminalHandle = container.querySelector('.cursor-row-resize') as HTMLElement
    expect(terminalHandle).toBeInTheDocument()

    const sidebar = container.querySelector('.kubecode-sidebar') as HTMLElement
    expect(sidebar.style.width).toBe('240px')
    fireEvent.mouseDown(handles[0], { clientX: 240 })
    fireEvent.mouseMove(document, { clientX: 280 })
    fireEvent.mouseUp(document)
    expect(sidebar.style.width).toBe('280px')

    const agentPanel = screen.getByTestId('ai-panel')
    expect(agentPanel.style.width).toBe('340px')
    fireEvent.mouseDown(handles[1], { clientX: 1100 })
    fireEvent.mouseMove(document, { clientX: 1060 })
    fireEvent.mouseUp(document)
    expect(agentPanel.style.width).toBe('380px')

    const terminalPane = container.querySelector('.kubecode-terminal-pane') as HTMLElement
    expect(terminalPane.style.height).toBe('260px')
    fireEvent.mouseDown(terminalHandle, { clientY: 600 })
    fireEvent.mouseMove(document, { clientY: 560 })
    fireEvent.mouseUp(document)
    expect(terminalPane.style.height).toBe('300px')

    fireEvent.click(screen.getByRole('button', { name: 'Close AI panel' }))
    expect(screen.queryByTestId('ai-panel')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'AI Agent' }))
    expect(screen.getByTestId('ai-panel')).toBeInTheDocument()
  })
})
