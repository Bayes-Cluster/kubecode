import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TerminalWorkspace } from './TerminalWorkspace'
import type { KubecodeApi, TerminalInfo } from './api'

vi.mock('./TerminalView', () => ({
  TerminalView: ({
    onSelectionChange,
    terminal,
  }: {
    onSelectionChange?: (terminalId: string, selectedText: string | null) => void
    terminal: TerminalInfo
  }) => (
    <div data-testid={`terminal-${terminal.id}`}>
      {terminal.title}
      <button
        data-has-selection-callback={Boolean(onSelectionChange)}
        onClick={() => onSelectionChange?.(terminal.id, `selected-${terminal.id}`)}
        onMouseDown={(event) => event.stopPropagation()}
        type="button"
      >{`select-${terminal.id}`}</button>
    </div>
  ),
}))

const agents = [
  { id: 'claude_code' as const, available: true, version: '1', executable: 'claude', error: null },
  { id: 'codex' as const, available: true, version: '1', executable: 'codex', error: null },
  { id: 'opencode' as const, available: false, version: null, executable: 'opencode', error: 'missing' },
]

describe('TerminalWorkspace', () => {
  beforeEach(() => localStorage.clear())

  it('reports each visible split pane and only its explicit current selection', async () => {
    const first = terminal('terminal-1', 'Sensitive /project/path', 'regular')
    const second = terminal('terminal-2', 'npm run private-command', 'regular')
    localStorage.setItem('kubecode:terminal-layout:project-1', JSON.stringify({
      activeTerminalId: first.id,
      layout: {
        type: 'split', id: 'split-1', direction: 'horizontal', ratio: 50,
        first: { type: 'leaf', terminalId: first.id },
        second: { type: 'leaf', terminalId: second.id },
      },
    }))
    const onContextSourcesChange = vi.fn()
    render(
      <TerminalWorkspace
        agents={agents}
        api={{} as KubecodeApi}
        initialTerminals={[first, second]}
        onContextSourcesChange={onContextSourcesChange}
        projectId="project-1"
        t={(key) => key}
      />,
    )

    await waitFor(() => expect(onContextSourcesChange).toHaveBeenCalledWith([
      { terminalId: 'terminal-1', paneIndex: 1, selectedText: null },
      { terminalId: 'terminal-2', paneIndex: 2, selectedText: null },
    ]))
    const selection = screen.getByRole('button', { name: 'select-terminal-2' })
    expect(selection).toHaveAttribute('data-has-selection-callback', 'true')
    fireEvent.click(selection)
    await waitFor(() => expect(onContextSourcesChange).toHaveBeenCalledWith([
      { terminalId: 'terminal-1', paneIndex: 1, selectedText: null },
      { terminalId: 'terminal-2', paneIndex: 2, selectedText: 'selected-terminal-2' },
    ]))
    expect(onContextSourcesChange.mock.calls.at(-1)?.[0]).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ title: expect.anything() }),
    ]))
  })

  it('creates regular or agent TUI terminals from the profile menu', async () => {
    const codex = terminal('codex-1', 'Codex', 'codex')
    const api = {
      createTerminal: vi.fn().mockResolvedValue(codex),
      closeTerminal: vi.fn().mockResolvedValue(undefined),
    } as unknown as KubecodeApi

    const { container } = render(
      <TerminalWorkspace
        agents={agents}
        api={api}
        conversationId="session-current"
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
      expect(api.createTerminal).toHaveBeenCalledWith('project-1', 'codex', 100, 28, 'session-current')
    })
    expect(screen.getByTestId('terminal-codex-1')).toBeInTheDocument()
    expect(container.querySelector('.kubecode-terminal-toolbar')).toHaveTextContent('')
    expect(container.querySelector('.kubecode-terminal-toolbar img')).not.toBeInTheDocument()
    expect(screen.queryByRole('tree', { name: 'kubecode.terminal' })).not.toBeInTheDocument()
  })

  it('splits the active terminal right and down without fixed proportions', async () => {
    const first = terminal('terminal-1', 'Codex', 'codex', 'session-original')
    const second = terminal('terminal-2', 'Codex', 'codex', 'session-original')
    const third = terminal('terminal-3', 'Codex', 'codex', 'session-original')
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
        conversationId="session-current"
        initialTerminals={[first]}
        projectId="project-1"
        t={(key) => key}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'kubecode.splitRight' }))
    await screen.findByTestId('terminal-terminal-2')
    expect(screen.getAllByTestId(/^terminal-terminal-/)).toHaveLength(2)
    expect(within(screen.getByRole('tree', { name: 'kubecode.terminal' })).getAllByRole('treeitem'))
      .toHaveLength(2)
    expect(api.createTerminal).toHaveBeenLastCalledWith(
      'project-1',
      'codex',
      100,
      28,
      'session-original',
    )
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
    const navigator = screen.getByRole('tree', { name: 'kubecode.terminal' })
    expect(within(navigator).getByRole('treeitem', { name: /Shell/ })).toHaveAttribute('data-active', 'true')
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
  })

  it('renames a terminal from the side navigator', async () => {
    const first = terminal('terminal-1', 'Terminal 1', 'regular')
    const second = terminal('terminal-2', 'Terminal 2', 'regular')
    const renamed = { ...first, title: 'Build shell' }
    const api = {
      closeTerminal: vi.fn().mockResolvedValue(undefined),
      createTerminal: vi.fn(),
      updateTerminal: vi.fn().mockResolvedValue(renamed),
    } as unknown as KubecodeApi

    render(
      <TerminalWorkspace
        agents={agents}
        api={api}
        initialTerminals={[first, second]}
        projectId="project-1"
        t={(key) => key}
      />,
    )

    fireEvent.doubleClick(screen.getByRole('treeitem', { name: /Terminal 1/ }))
    const title = screen.getByRole('textbox', { name: 'kubecode.terminalTitle' })
    fireEvent.change(title, { target: { value: 'Build shell' } })
    fireEvent.keyDown(title, { key: 'Enter' })
    await waitFor(() => expect(api.updateTerminal).toHaveBeenCalledWith('terminal-1', 'Build shell'))
  })

  it('collapses and restores the resizable terminal navigator', () => {
    const first = terminal('terminal-1', 'Terminal 1', 'regular')
    const second = terminal('terminal-2', 'Terminal 2', 'regular')
    const api = {
      closeTerminal: vi.fn().mockResolvedValue(undefined),
      createTerminal: vi.fn(),
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

    const toggle = screen.getByRole('button', { name: 'kubecode.collapse' })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('tree', { name: 'kubecode.terminal' })).toHaveStyle({ width: '120px' })
    expect(container.querySelector('.kubecode-terminal-body > .cursor-col-resize')).toBeInTheDocument()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('tree', { name: 'kubecode.terminal' })).toHaveStyle({ width: '46px' })
    expect(screen.getByRole('tree', { name: 'kubecode.terminal' })).toHaveAttribute('data-narrow', 'true')

    fireEvent.click(toggle)
    expect(screen.getByRole('tree', { name: 'kubecode.terminal' })).toHaveStyle({ width: '120px' })
  })

  it('folds the dock when its final server terminal disappears', async () => {
    const first = terminal('terminal-1', 'Terminal 1', 'regular')
    const onCollapse = vi.fn()
    const api = {
      closeTerminal: vi.fn().mockResolvedValue(undefined),
      createTerminal: vi.fn(),
    } as unknown as KubecodeApi
    const { rerender } = render(
      <TerminalWorkspace
        agents={agents}
        api={api}
        initialTerminals={[first]}
        onCollapse={onCollapse}
        projectId="project-1"
        t={(key) => key}
      />,
    )

    rerender(
      <TerminalWorkspace
        agents={agents}
        api={api}
        initialTerminals={[]}
        onCollapse={onCollapse}
        projectId="project-1"
        t={(key) => key}
      />,
    )

    await waitFor(() => expect(onCollapse).toHaveBeenCalledOnce())
  })

  it('restarts an exited terminal in its original Session workspace', async () => {
    const exited = {
      ...terminal('terminal-1', 'Terminal 1', 'regular', 'session-original'),
      status: 'exited' as const,
      exit_code: 1,
    }
    const restarted = terminal('terminal-2', 'Terminal 1', 'regular', 'session-original')
    const api = {
      closeTerminal: vi.fn().mockResolvedValue(undefined),
      createTerminal: vi.fn().mockResolvedValue(restarted),
    } as unknown as KubecodeApi
    render(
      <TerminalWorkspace
        agents={agents}
        api={api}
        conversationId="session-current"
        initialTerminals={[exited]}
        projectId="project-1"
        t={(key) => key}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'kubecode.restartTerminal' }))

    await waitFor(() => expect(api.createTerminal).toHaveBeenCalledWith(
      'project-1',
      'regular',
      100,
      28,
      'session-original',
    ))
  })
})

function terminal(
  id: string,
  title: string,
  kind: TerminalInfo['kind'],
  conversationId: string | null = null,
): TerminalInfo {
  return {
    id,
    project_id: 'project-1',
    conversation_id: conversationId,
    title,
    kind,
    cols: 100,
    rows: 28,
    status: 'running',
    exit_code: null,
    signal: null,
  }
}
