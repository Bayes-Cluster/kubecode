import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { TerminalWorkspace } from './TerminalWorkspace'
import type { KubecodeApi, TerminalInfo } from './api'

vi.mock('./TerminalView', () => ({
  TerminalView: ({ terminal }: { terminal: TerminalInfo }) => (
    <div data-testid={`terminal-${terminal.id}`}>{terminal.title}</div>
  ),
}))

const agents = [
  { id: 'claude_code' as const, available: true, version: '1', executable: 'claude', error: null },
  { id: 'codex' as const, available: true, version: '1', executable: 'codex', error: null },
  { id: 'opencode' as const, available: false, version: null, executable: 'opencode', error: 'missing' },
]

describe('TerminalWorkspace', () => {
  it('creates regular or agent TUI terminals from the profile menu', async () => {
    const codex = terminal('codex-1', 'Codex', 'codex')
    const api = {
      createTerminal: vi.fn().mockResolvedValue(codex),
      closeTerminal: vi.fn().mockResolvedValue(undefined),
    } as unknown as KubecodeApi

    render(
      <TerminalWorkspace
        agents={agents}
        api={api}
        initialTerminals={[]}
        projectId="project-1"
        t={(key) => key}
      />,
    )

    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'kubecode.newTerminal' }),
      { button: 0 },
    )
    expect(screen.getByRole('menuitem', { name: /kubecode.regularTerminal/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Claude Code/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Codex/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /OpenCode/ })).toHaveAttribute('data-disabled')
    fireEvent.click(screen.getByRole('menuitem', { name: /Codex/ }))

    await waitFor(() => {
      expect(api.createTerminal).toHaveBeenCalledWith('project-1', 'codex', 100, 28)
    })
    expect(screen.getByTestId('terminal-codex-1')).toBeInTheDocument()
    expect(document.querySelector('img[src="./ai-agent-icons/codex.svg"]')).toBeInTheDocument()
  })

  it('splits the active terminal right and down without fixed proportions', async () => {
    const first = terminal('terminal-1', 'Codex', 'codex')
    const second = terminal('terminal-2', 'Codex', 'codex')
    const third = terminal('terminal-3', 'Codex', 'codex')
    const api = {
      createTerminal: vi.fn()
        .mockResolvedValueOnce(second)
        .mockResolvedValueOnce(third),
      closeTerminal: vi.fn().mockResolvedValue(undefined),
    } as unknown as KubecodeApi

    const { container } = render(
      <TerminalWorkspace
        agents={agents}
        api={api}
        initialTerminals={[first]}
        projectId="project-1"
        t={(key) => key}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'kubecode.splitRight' }))
    await screen.findByTestId('terminal-terminal-2')
    expect(screen.getAllByTestId(/^terminal-terminal-/)).toHaveLength(2)
    expect(api.createTerminal).toHaveBeenLastCalledWith('project-1', 'codex', 100, 28)
    expect(container.querySelector('[data-split-direction="horizontal"]')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'kubecode.splitDown' }))
    await screen.findByTestId('terminal-terminal-3')
    expect(screen.getAllByTestId(/^terminal-terminal-/)).toHaveLength(3)
    expect(container.querySelector('[data-split-direction="vertical"]')).toBeInTheDocument()
  })
})

function terminal(
  id: string,
  title: string,
  kind: TerminalInfo['kind'],
): TerminalInfo {
  return { id, project_id: 'project-1', title, kind, cols: 100, rows: 28 }
}
