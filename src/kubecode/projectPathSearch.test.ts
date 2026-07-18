import { describe, expect, it, vi } from 'vitest'

import type { KubecodeApi } from './api'
import { searchProjectEntries } from './projectPathSearch'

describe('searchProjectEntries', () => {
  it('searches recursively while excluding generated and hidden entries by default', async () => {
    const listEntries = vi.fn().mockImplementation((_projectId: string, path: string) => {
      const entries = {
        '': [
          { kind: 'directory', name: 'src', path: 'src' },
          { kind: 'directory', name: 'node_modules', path: 'node_modules' },
          { kind: 'file', name: '.env', path: '.env', hidden: true },
        ],
        src: [
          { kind: 'file', name: 'main.ts', path: 'src/main.ts' },
          { kind: 'file', name: 'main.test.ts', path: 'src/main.test.ts' },
        ],
      } as const
      return Promise.resolve(entries[path as keyof typeof entries] ?? [])
    })

    const results = await searchProjectEntries({
      api: { listEntries } as unknown as KubecodeApi,
      projectId: 'project-1',
      query: 'main',
    })

    expect(results.map((entry) => entry.path)).toEqual([
      'src/main.ts',
      'src/main.test.ts',
    ])
    expect(listEntries).not.toHaveBeenCalledWith('project-1', 'node_modules')
  })

  it('can reveal excluded entries and enforces the result limit', async () => {
    const listEntries = vi.fn().mockResolvedValue([
      { kind: 'file', name: '.env', path: '.env', hidden: true },
      ...Array.from({ length: 110 }, (_, index) => ({
        kind: 'file' as const,
        name: `file-${index}.ts`,
        path: `file-${index}.ts`,
      })),
    ])

    const results = await searchProjectEntries({
      api: { listEntries } as unknown as KubecodeApi,
      includeExcluded: true,
      maxResults: 100,
      projectId: 'project-1',
      query: '',
    })

    expect(results).toHaveLength(100)
    expect(results[0]?.path).toBe('.env')
  })
})
