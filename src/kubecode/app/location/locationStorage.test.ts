import { describe, expect, it, vi } from 'vitest'

import type { PreferenceStorage } from '../../preferenceStorage'
import {
  LOCATION_STORAGE_KEY,
  readLocationMemory,
  writeLocationMemory,
} from './locationStorage'
import {
  EMPTY_MEMORY,
  locationReducer,
  MAX_REMEMBERED_VIEWS,
  MAX_REMEMBERED_WORKSPACES,
  type LocationAction,
  type LocationMemory,
} from './workspaceLocation'

function memoryStorage(initial: Record<string, string> = {}): PreferenceStorage & { values: Record<string, string> } {
  const values = { ...initial }
  return {
    values,
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value
    },
  }
}

function stored(value: unknown): PreferenceStorage & { values: Record<string, string> } {
  return memoryStorage({ [LOCATION_STORAGE_KEY]: JSON.stringify(value) })
}

function run(...actions: LocationAction[]): LocationMemory {
  return actions.reduce(locationReducer, EMPTY_MEMORY)
}

describe('stored workspace locations', () => {
  it('keeps every remembered place across a reload, as routes', () => {
    const memory = run(
      { type: 'go', projectId: 'p1', target: { view: 'general', message: 'm9', filter: 'r1' }, inspector: [{ kind: 'task', id: 'r1' }] },
      { type: 'go', projectId: 'p1', target: { view: 'board' }, inspector: [{ kind: 'task', id: 'r1' }] },
      { type: 'go', projectId: 'p2', target: { view: 'dm', member: 'm1' } },
      { type: 'go', projectId: 'p2', target: { view: 'sessions', conversation: 'c1' } },
      { type: 'enterWorkspace', projectId: 'p1' },
    )
    const storage = memoryStorage()
    writeLocationMemory(storage, memory)
    expect(JSON.parse(storage.values[LOCATION_STORAGE_KEY])).toEqual({
      lastProjectId: 'p1',
      seq: memory.seq,
      workspaces: {
        p1: {
          current: 'board',
          at: memory.workspaces.p1.at,
          views: { general: '/p/p1/general/m/m9?task=r1&filter=r1', board: '/p/p1/board?task=r1' },
        },
        p2: {
          current: 'sessions',
          at: memory.workspaces.p2.at,
          views: { 'dm:m1': '/p/p2/dm/m1', sessions: '/p/p2/sessions/c/c1' },
        },
      },
    })
    expect(readLocationMemory(storage)).toEqual(memory)
  })

  it('never writes a file path, only the routable part of a stack', () => {
    const memory = run({
      type: 'go',
      projectId: 'p1',
      target: { view: 'general' },
      inspector: [{ kind: 'task', id: 'r1' }, { kind: 'evidence', ref: { kind: 'file', id: 'results.csv' } }],
    })
    const storage = memoryStorage()
    writeLocationMemory(storage, memory)
    expect(storage.values[LOCATION_STORAGE_KEY]).not.toContain('results.csv')
    expect(readLocationMemory(storage).workspaces.p1.views.general?.inspector).toEqual([{ kind: 'task', id: 'r1' }])
  })

  it('starts empty from damaged or missing storage', () => {
    expect(readLocationMemory(null)).toEqual(EMPTY_MEMORY)
    expect(readLocationMemory(memoryStorage())).toEqual(EMPTY_MEMORY)
    expect(readLocationMemory(memoryStorage({ [LOCATION_STORAGE_KEY]: '{not json' }))).toEqual(EMPTY_MEMORY)
    for (const value of [null, 7, 'x', [], { workspaces: [] }, { workspaces: 'x' }]) {
      expect(readLocationMemory(stored(value)), JSON.stringify(value)).toEqual(EMPTY_MEMORY)
    }
  })

  it('drops any stored place that does not belong to its slot', () => {
    const memory = readLocationMemory(stored({
      lastProjectId: 7,
      seq: 'x',
      workspaces: {
        p1: {
          current: 'board',
          at: 3,
          views: {
            general: '/p/p1/general/m/m1',
            board: '/p/OTHER/board?task=r1',
            resources: '/p/p1/members',
            members: 'garbage',
            'dm:m1': 42,
            sessions: '/sessions',
          },
        },
        p2: { current: 'nowhere', at: 'x', views: { general: '/p/p2/general', 'dm:m2': '/p/p2/dm/m2' } },
        p3: { current: 'dm:a/b', views: null },
        p4: 'broken',
        p5: { current: 5, at: 2, views: {} },
        'bad/id': { current: 'general', at: 1, views: { general: '/p/bad%2Fid/general' } },
      },
    }))
    expect(memory.lastProjectId).toBeNull()
    expect(memory.workspaces.p1).toEqual({
      current: 'board',
      at: 3,
      views: { general: { place: { view: 'general', message: 'm1' }, inspector: [] } },
    })
    expect(memory.workspaces.p2).toEqual({
      current: 'general',
      at: 0,
      views: {
        general: { place: { view: 'general' }, inspector: [] },
        'dm:m2': { place: { view: 'dm', member: 'm2' }, inspector: [] },
      },
    })
    expect(memory.workspaces.p3).toEqual({ current: 'general', at: 0, views: {} })
    expect(memory.workspaces.p4).toBeUndefined()
    expect(memory.workspaces.p5).toEqual({ current: 'general', at: 2, views: {} })
    expect(memory.workspaces['bad/id']).toBeUndefined()
    // The counter never falls behind a stamp it has handed out.
    expect(memory.seq).toBe(3)
  })

  it('keeps a remembered view that names a member or a question', () => {
    const memory = readLocationMemory(stored({
      lastProjectId: 'p1',
      seq: 9,
      workspaces: { p1: { current: 'question:q1', at: 9, views: { 'question:q1': '/p/p1/question/q1' } } },
    }))
    expect(memory.lastProjectId).toBe('p1')
    expect(memory.workspaces.p1.current).toBe('question:q1')
    expect(memory.workspaces.p1.views['question:q1']).toEqual({ place: { view: 'question', question: 'q1' }, inspector: [] })
  })

  it('opens General when the stored current view key has no separator', () => {
    for (const current of ['dm1', 'dmx', 'questionQ', 'question', 'dm', ':m1', 'dm:', 'question:']) {
      const memory = readLocationMemory(stored({
        lastProjectId: 'p1',
        seq: 1,
        workspaces: { p1: { current, at: 1, views: {} } },
      }))
      expect(memory.workspaces.p1.current, current).toBe('general')
    }
  })

  it('drops a stored view whose key has no separator', () => {
    const memory = readLocationMemory(stored({
      lastProjectId: 'p1',
      seq: 1,
      workspaces: { p1: { current: 'general', at: 1, views: { dm1: '/p/p1/dm/m1', general: '/p/p1/general' } } },
    }))
    expect(Object.keys(memory.workspaces.p1.views)).toEqual(['general'])
  })

  it('applies the limits on read', () => {
    const views: Record<string, string> = { general: '/p/p1/general' }
    for (let index = 0; index < MAX_REMEMBERED_VIEWS + 3; index += 1) views[`dm:m${index}`] = `/p/p1/dm/m${index}`
    const workspaces: Record<string, unknown> = { p1: { current: 'general', at: 1000, views } }
    for (let index = 0; index < MAX_REMEMBERED_WORKSPACES + 5; index += 1) {
      workspaces[`w${index}`] = { current: 'board', at: index, views: { board: `/p/w${index}/board` } }
    }
    const memory = readLocationMemory(stored({ lastProjectId: 'p1', seq: 1000, workspaces }))
    expect(Object.keys(memory.workspaces)).toHaveLength(MAX_REMEMBERED_WORKSPACES)
    expect(memory.workspaces.w0).toBeUndefined()
    expect(Object.keys(memory.workspaces.p1.views)).toHaveLength(MAX_REMEMBERED_VIEWS)
    expect(memory.workspaces.p1.views.general).toBeDefined()
    expect(memory.workspaces.p1.views['dm:m0']).toBeUndefined()
  })

  it('swallows storage that throws', () => {
    const throwing: PreferenceStorage = {
      getItem: vi.fn(() => {
        throw new Error('denied')
      }),
      setItem: vi.fn(() => {
        throw new Error('quota')
      }),
    }
    expect(readLocationMemory(throwing)).toEqual(EMPTY_MEMORY)
    expect(() => writeLocationMemory(throwing, run({ type: 'go', projectId: 'p1', target: { view: 'board' } })))
      .not.toThrow()
    expect(() => writeLocationMemory(null, EMPTY_MEMORY)).not.toThrow()
  })
})
