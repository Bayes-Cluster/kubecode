import { beforeEach, describe, expect, it } from 'vitest'

import {
  readTerminalSnapshot,
  removeTerminalSnapshot,
  writeTerminalSnapshot,
} from './terminalSnapshots'

describe('terminalSnapshots', () => {
  beforeEach(() => sessionStorage.clear())

  it('restores and removes a project-scoped terminal snapshot', () => {
    const snapshot = { buffer: 'previous output', cols: 120, cursor: 42, rows: 32, scrollY: 7 }

    writeTerminalSnapshot('project-1', 'terminal-1', snapshot)

    expect(readTerminalSnapshot('project-1', 'terminal-1')).toEqual(snapshot)
    expect(readTerminalSnapshot('project-2', 'terminal-1')).toBeNull()
    removeTerminalSnapshot('project-1', 'terminal-1')
    expect(readTerminalSnapshot('project-1', 'terminal-1')).toBeNull()
  })

  it('ignores malformed or negative snapshot metadata', () => {
    sessionStorage.setItem('kubecode:terminal-snapshot:project-1:terminal-1', JSON.stringify({
      buffer: 'output',
      cols: -1,
      cursor: 2,
      rows: 24,
      scrollY: 0,
    }))

    expect(readTerminalSnapshot('project-1', 'terminal-1')).toBeNull()
  })
})
