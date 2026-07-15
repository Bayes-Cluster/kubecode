import { describe, expect, it } from 'vitest'

import type { TerminalInfo } from './api'
import {
  closeTerminalLeaf,
  createTerminalGroup,
  readTerminalWorkspace,
  reconcileTerminalWorkspace,
  splitTerminalLeaf,
  terminalIds,
} from './terminalWorkspaceState'

describe('terminalWorkspaceState', () => {
  it('migrates the legacy split tree and preserves orphaned terminals as groups', () => {
    const first = terminal('terminal-1')
    const second = terminal('terminal-2')
    const orphan = terminal('terminal-3')
    localStorage.setItem('kubecode:terminal-layout:project-1', JSON.stringify({
      activeTerminalId: second.id,
      layout: {
        type: 'split',
        id: 'legacy-split',
        direction: 'horizontal',
        ratio: 82,
        first: { type: 'leaf', terminalId: first.id },
        second: { type: 'leaf', terminalId: second.id },
      },
    }))

    const workspace = readTerminalWorkspace('project-1', [first, second, orphan])

    expect(workspace.version).toBe(2)
    expect(workspace.groups).toHaveLength(2)
    expect(workspace.groups[0]?.layout.type).toBe('split')
    expect(workspace.groups[0]?.activeTerminalId).toBe(second.id)
    expect(workspace.groups[1]?.layout).toEqual({ type: 'leaf', terminalId: orphan.id })
    expect(workspace.activeGroupId).toBe(workspace.groups[0]?.id)
  })

  it('creates groups, splits the active leaf, and collapses a closed split leaf', () => {
    const group = createTerminalGroup('group-1', 'terminal-1')
    const split = splitTerminalLeaf(group, 'terminal-1', 'terminal-2', 'horizontal', 'split-1')

    expect(split.layout.type).toBe('split')
    expect(split.activeTerminalId).toBe('terminal-2')
    expect(closeTerminalLeaf(split, 'terminal-2')?.layout).toEqual({
      type: 'leaf',
      terminalId: 'terminal-1',
    })
    expect(closeTerminalLeaf(group, 'terminal-1')).toBeNull()
  })

  it('removes closed terminals and adds server-side terminals during reconciliation', () => {
    const initial = readTerminalWorkspace('project-1', [terminal('first')])

    const reconciled = reconcileTerminalWorkspace(initial, [terminal('second')])

    expect(reconciled.groups).toHaveLength(1)
    expect(terminalIds(reconciled.groups[0].layout)).toEqual(['second'])
  })
})

function terminal(id: string): TerminalInfo {
  return {
    id,
    project_id: 'project-1',
    title: id,
    kind: 'regular',
    cols: 100,
    rows: 28,
    status: 'running',
    exit_code: null,
    signal: null,
  }
}
