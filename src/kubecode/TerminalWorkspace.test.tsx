import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  beforeEach(() => localStorage.clear())

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
      screen.getByRole('button', { name: 'kubecode.terminalProfiles' }),
      { button: 0 },
    )
    expect(screen.getByRole('menuitem', { name: /^kubecode.terminal$/ })).toBeInTheDocument()
    expect(screen.queryByText(/regular terminal/i)).not.toBeInTheDocument()
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

  it('restores a project split tree and its freely resized ratio', async () => {
    const first = terminal('terminal-1', 'Codex', 'codex')
    const second = terminal('terminal-2', 'Shell', 'regular')
    localStorage.setItem('kubecode:terminal-layout:project-1', JSON.stringify({
      activeTerminalId: second.id,
      layout: {
        type: 'split',
        id: 'saved-split',
        direction: 'horizontal',
        ratio: 82,
        first: { type: 'leaf', terminalId: first.id },
        second: { type: 'leaf', terminalId: second.id },
      },
    }))
    const api = {
      createTerminal: vi.fn(),
      closeTerminal: vi.fn().mockResolvedValue(undefined),
    } as unknown as KubecodeApi
    const { container } = render(
      <TerminalWorkspace
        agents={agents}
        api={api}
        initialTerminals={[first, second]}
        projectId="project-1"
        t={(key) => key}
      />,
    )

    expect(screen.getAllByTestId(/^terminal-terminal-/)).toHaveLength(2)
    const children = container.querySelectorAll('.kubecode-terminal-split-child')
    expect((children[0] as HTMLElement).style.flexBasis).toBe('82%')
    expect((children[1] as HTMLElement).style.flexBasis).toBe('18%')
    expect(screen.getByRole('tab', { name: /Shell/ })).toHaveAttribute('data-variant', 'secondary')
  })

  it('renames a terminal tab and folds the dock from its own toolbar', async () => {
    const first = terminal('terminal-1', 'Terminal 1', 'regular')
    const renamed = { ...first, title: 'Build shell' }
    const onCollapse = vi.fn()
    const api = {
      closeTerminal: vi.fn().mockResolvedValue(undefined),
      createTerminal: vi.fn(),
      updateTerminal: vi.fn().mockResolvedValue(renamed),
    } as unknown as KubecodeApi

    render(
      <TerminalWorkspace
        agents={agents}
        api={api}
        initialTerminals={[first]}
        onCollapse={onCollapse}
        projectId="project-1"
        t={(key) => key}
      />,
    )

    fireEvent.doubleClick(screen.getByRole('tab', { name: /Terminal 1/ }))
    const title = screen.getByRole('textbox', { name: 'kubecode.terminalTitle' })
    fireEvent.change(title, { target: { value: 'Build shell' } })
    fireEvent.keyDown(title, { key: 'Enter' })
    await waitFor(() => expect(api.updateTerminal).toHaveBeenCalledWith('terminal-1', 'Build shell'))

    fireEvent.click(screen.getByRole('button', { name: 'kubecode.collapse' }))
    expect(onCollapse).toHaveBeenCalledOnce()
  })
})

function terminal(
  id: string,
  title: string,
  kind: TerminalInfo['kind'],
): TerminalInfo {
  return {
    id,
    project_id: 'project-1',
    title,
    kind,
    cols: 100,
    rows: 28,
    status: 'running',
    exit_code: null,
    signal: null,
  }
}
