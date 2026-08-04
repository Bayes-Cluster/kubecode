import { describe, expect, it } from 'vitest'

import type { WorkspaceEvent } from './api'
import {
  MAX_FILE_CHANGED_PATHS,
  aggregateFileChangedEvents,
  parentDirectoryPath,
} from './fileTreeInvalidation'

function fileChangedEvent(id: number, payload: Record<string, unknown>): WorkspaceEvent {
  return {
    id,
    kind: 'file_changed',
    project_id: 'project-1',
    conversation_id: null,
    run_id: null,
    payload,
    created_at: 'now',
  }
}

describe('aggregateFileChangedEvents', () => {
  it('unions, sorts, and deduplicates scoped paths', () => {
    expect(aggregateFileChangedEvents([
      fileChangedEvent(1, { paths: ['b.txt'] }),
      fileChangedEvent(2, { paths: ['a.txt', 'b.txt'] }),
      fileChangedEvent(3, { paths: ['src/c.ts'] }),
    ])).toEqual({ paths: ['a.txt', 'b.txt', 'src/c.ts'] })
  })

  it('treats a full event as a full invalidation even with paths', () => {
    expect(aggregateFileChangedEvents([
      fileChangedEvent(1, { paths: ['a.txt'], full: true }),
    ])).toEqual({ paths: [], full: true })
  })

  it('treats a malformed path list as a full invalidation', () => {
    expect(aggregateFileChangedEvents([
      fileChangedEvent(1, { paths: 'not-an-array' }),
    ])).toEqual({ paths: [], full: true })
    expect(aggregateFileChangedEvents([
      fileChangedEvent(1, { paths: [42] }),
    ])).toEqual({ paths: [], full: true })
  })

  it('fails closed to full when the accumulated path count exceeds the cap', () => {
    const events = Array.from({ length: 3 }, (_value, index) => fileChangedEvent(
      index + 1,
      { paths: Array.from({ length: 100 }, (_path, pathIndex) => `f${index}-${pathIndex}.txt`) },
    ))
    expect(aggregateFileChangedEvents(events)).toEqual({ paths: [], full: true })
    expect(MAX_FILE_CHANGED_PATHS).toBe(256)
  })

  it('returns an empty scoped event when no usable paths are present', () => {
    expect(aggregateFileChangedEvents([fileChangedEvent(1, { paths: [] })])).toEqual({ paths: [] })
  })
})

describe('parentDirectoryPath', () => {
  it('resolves the owning directory without exposing the Project root', () => {
    expect(parentDirectoryPath('README.md')).toBe('')
    expect(parentDirectoryPath('src/main.ts')).toBe('src')
    expect(parentDirectoryPath('src/nested/deep.txt')).toBe('src/nested')
  })
})
