import { describe, expect, it } from 'vitest'

import type { Entry } from './api'
import { deriveVisibleTreeRows } from './visibleTreeRows'

function entry(path: string, kind: Entry['kind'] = 'file'): Entry {
  return { kind, name: path.split('/').at(-1) ?? path, path }
}

describe('deriveVisibleTreeRows', () => {
  it('projects expanded cached directories into stable rows with sibling metadata', () => {
    const rows = deriveVisibleTreeRows({
      directories: new Map([
        ['', { entries: [entry('src', 'directory'), entry('README.md')] }],
        ['src', { entries: [entry('src/index.ts'), entry('src/components', 'directory')] }],
        ['src/components', { entries: [entry('src/components/App.tsx')] }],
      ]),
      expanded: new Set(['', 'src', 'src/components']),
      projectName: 'Demo',
    })

    expect(rows.map((row) => [row.path, row.depth, row.kind, row.isExpanded])).toEqual([
      ['', 0, 'directory', true],
      ['src', 1, 'directory', true],
      ['src/index.ts', 2, 'file', false],
      ['src/components', 2, 'directory', true],
      ['src/components/App.tsx', 3, 'file', false],
      ['README.md', 1, 'file', false],
    ])
    expect(rows[1]).toMatchObject({
      id: 'src',
      isFirstSibling: true,
      isLastSibling: false,
      parentPath: '',
      siblingCount: 2,
      siblingIndex: 0,
    })
    expect(rows[5]).toMatchObject({
      id: 'README.md',
      isFirstSibling: false,
      isLastSibling: true,
      parentPath: '',
      siblingCount: 2,
      siblingIndex: 1,
    })
  })

  it('keeps paths stable when sibling entries are inserted or renamed', () => {
    const directories = new Map([
      ['', { entries: [entry('b.txt'), entry('c.txt')] }],
    ])
    const before = deriveVisibleTreeRows({
      directories,
      expanded: new Set(['']),
      projectName: 'Demo',
    })
    directories.set('', { entries: [entry('a.txt'), entry('b.txt'), entry('c-renamed.txt')] })
    const after = deriveVisibleTreeRows({
      directories,
      expanded: new Set(['']),
      projectName: 'Demo',
    })

    expect(before.map((row) => row.id)).toContain('b.txt')
    expect(after.map((row) => row.id)).toContain('b.txt')
    expect(after.map((row) => row.id)).toContain('c-renamed.txt')
  })
})
