import { describe, expect, it } from 'vitest'

import type { InspectorEntry } from './inspector'
import {
  capMemory,
  EMPTY_MEMORY,
  homeViewFor,
  hostsInspector,
  locationOf,
  locationReducer,
  MAX_REMEMBERED_VIEWS,
  MAX_REMEMBERED_WORKSPACES,
  pickInitialWorkspace,
  viewKeyOf,
  type LocationAction,
  type LocationMemory,
  type WorkspaceLocation,
} from './workspaceLocation'

const task = (id: string): InspectorEntry => ({ kind: 'task', id })
const member = (id: string): InspectorEntry => ({ kind: 'member', id })
const GENERAL: WorkspaceLocation = { place: { view: 'general' }, inspector: [] }

function run(...actions: LocationAction[]): LocationMemory {
  return actions.reduce(locationReducer, EMPTY_MEMORY)
}

describe('workspace locations', () => {
  it('opens General for a Workspace it has never seen', () => {
    expect(locationOf(EMPTY_MEMORY, 'p1')).toEqual(GENERAL)
    expect(locationOf(EMPTY_MEMORY, null)).toEqual(GENERAL)
    // Entering a Workspace remembers it as the last one, but creates no place.
    const memory = run({ type: 'enterWorkspace', projectId: 'p1' })
    expect(memory.lastProjectId).toBe('p1')
    expect(memory.workspaces.p1).toBeUndefined()
    expect(locationOf(memory, 'p1')).toEqual(GENERAL)
  })

  it('restores a view exactly as it was left', () => {
    const memory = run(
      { type: 'go', projectId: 'p1', target: { view: 'general', message: 'm1', filter: 'r1' }, inspector: [task('r1')] },
      { type: 'go', projectId: 'p1', target: { view: 'board' } },
    )
    expect(locationOf(memory, 'p1')).toEqual({ place: { view: 'board' }, inspector: [] })
    const back = locationReducer(memory, { type: 'go', projectId: 'p1', target: { view: 'general' } })
    expect(locationOf(back, 'p1')).toEqual({
      place: { view: 'general', message: 'm1', filter: 'r1' },
      inspector: [task('r1')],
    })
  })

  it('lets explicit fields override the remembered place, and null delete one', () => {
    const memory = run(
      { type: 'go', projectId: 'p1', target: { view: 'general', message: 'm1', filter: 'r1', thread: 't1' } },
      { type: 'go', projectId: 'p1', target: { view: 'general', message: 'm2', filter: null } },
    )
    expect(locationOf(memory, 'p1').place).toEqual({ view: 'general', message: 'm2', thread: 't1' })
    const sessions = run(
      { type: 'go', projectId: 'p1', target: { view: 'sessions', conversation: 'c1' } },
      { type: 'go', projectId: 'p1', target: { view: 'board' } },
      { type: 'go', projectId: 'p1', target: { view: 'sessions' } },
    )
    expect(locationOf(sessions, 'p1').place).toEqual({ view: 'sessions', conversation: 'c1' })
    expect(locationOf(
      locationReducer(sessions, { type: 'go', projectId: 'p1', target: { view: 'sessions', conversation: null } }),
      'p1',
    ).place).toEqual({ view: 'sessions' })
  })

  it('carries the current stack into another view when asked to keep it', () => {
    const memory = run(
      { type: 'go', projectId: 'p1', target: { view: 'board' }, inspector: [task('r1')] },
      { type: 'go', projectId: 'p1', target: { view: 'general', filter: 'r1' }, inspector: 'keep' },
    )
    expect(locationOf(memory, 'p1')).toEqual({ place: { view: 'general', filter: 'r1' }, inspector: [task('r1')] })
    // Nothing is inspected on the Sessions surface or a question, whatever was asked.
    const sessions = locationReducer(memory, {
      type: 'go', projectId: 'p1', target: { view: 'sessions' }, inspector: 'keep',
    })
    expect(locationOf(sessions, 'p1')).toEqual({ place: { view: 'sessions' }, inspector: [] })
    const question = locationReducer(memory, {
      type: 'go', projectId: 'p1', target: { view: 'question', question: 'q1' }, inspector: [task('r1')],
    })
    expect(locationOf(question, 'p1')).toEqual({ place: { view: 'question', question: 'q1' }, inspector: [] })
  })

  it('keeps every Workspace on its own place', () => {
    const memory = run(
      { type: 'go', projectId: 'A', target: { view: 'general' }, inspector: [task('r1')] },
      { type: 'go', projectId: 'B', target: { view: 'board' } },
    )
    expect(locationOf(memory, 'A')).toEqual({ place: { view: 'general' }, inspector: [task('r1')] })
    expect(locationOf(memory, 'B')).toEqual({ place: { view: 'board' }, inspector: [] })
  })

  it('inspects within the view on screen, or opens the entry where it lives', () => {
    const general = run(
      { type: 'go', projectId: 'p1', target: { view: 'general', message: 'm1' } },
      { type: 'inspect', projectId: 'p1', entry: task('r1'), mode: 'reset' },
      { type: 'inspect', projectId: 'p1', entry: member('m1'), mode: 'push' },
    )
    expect(locationOf(general, 'p1')).toEqual({
      place: { view: 'general', message: 'm1' }, inspector: [task('r1'), member('m1')],
    })
    // An unvisited Workspace is on General, which hosts an inspector.
    expect(locationOf(run({ type: 'inspect', projectId: 'p2', entry: task('r1'), mode: 'push' }), 'p2'))
      .toEqual({ place: { view: 'general' }, inspector: [task('r1')] })
    for (const [entry, view] of [
      [task('r1'), 'board'],
      [member('m1'), 'members'],
      [{ kind: 'evidence', ref: { kind: 'artifact', id: 'a1' } }, 'resources'],
      [{ kind: 'resource', ref: { kind: 'finding', id: 'f1' } }, 'resources'],
    ] as const) {
      const memory = run(
        { type: 'go', projectId: 'p1', target: { view: 'sessions', conversation: 'c1' } },
        { type: 'inspect', projectId: 'p1', entry, mode: 'push' },
      )
      expect(locationOf(memory, 'p1')).toEqual({ place: { view }, inspector: [entry] })
      expect(homeViewFor(entry)).toEqual({ view })
    }
  })

  it('pops and closes the inspector', () => {
    const memory = run(
      { type: 'go', projectId: 'p1', target: { view: 'board' }, inspector: [task('r1'), member('m1')] },
      { type: 'inspectorBack', projectId: 'p1' },
    )
    expect(locationOf(memory, 'p1').inspector).toEqual([task('r1')])
    expect(locationOf(locationReducer(memory, { type: 'inspectorClose', projectId: 'p1' }), 'p1').inspector).toEqual([])
    // Nothing to pop or close is no change at all.
    const closed = locationReducer(memory, { type: 'inspectorClose', projectId: 'p1' })
    expect(locationReducer(closed, { type: 'inspectorBack', projectId: 'p1' })).toBe(closed)
    expect(locationReducer(closed, { type: 'inspectorClose', projectId: 'p1' })).toBe(closed)
    const sessions = run({ type: 'go', projectId: 'p1', target: { view: 'sessions' } })
    expect(locationReducer(sessions, { type: 'inspectorClose', projectId: 'p1' })).toBe(sessions)
  })

  it('patches General and the Sessions surface only while they are on screen', () => {
    const general = run({ type: 'go', projectId: 'p1', target: { view: 'general', message: 'm1', filter: 'r1' } })
    const patched = locationReducer(general, { type: 'patchGeneral', projectId: 'p1', patch: { message: 'm2', filter: null } })
    expect(locationOf(patched, 'p1').place).toEqual({ view: 'general', message: 'm2' })
    expect(locationReducer(general, { type: 'patchSessions', projectId: 'p1', conversation: 'c1' })).toBe(general)

    const board = locationReducer(general, { type: 'go', projectId: 'p1', target: { view: 'board' } })
    expect(locationReducer(board, { type: 'patchGeneral', projectId: 'p1', patch: { message: 'm9' } })).toBe(board)

    const sessions = locationReducer(general, { type: 'go', projectId: 'p1', target: { view: 'sessions' } })
    const filled = locationReducer(sessions, { type: 'patchSessions', projectId: 'p1', conversation: 'c1' })
    expect(locationOf(filled, 'p1').place).toEqual({ view: 'sessions', conversation: 'c1' })
    expect(locationOf(
      locationReducer(filled, { type: 'patchSessions', projectId: 'p1', conversation: null }), 'p1',
    ).place).toEqual({ view: 'sessions' })
    // An unvisited Workspace is on General, so General may be patched there.
    expect(locationOf(run({ type: 'patchGeneral', projectId: 'p2', patch: { message: 'm1' } }), 'p2').place)
      .toEqual({ view: 'general', message: 'm1' })
  })

  it('writes a route exactly and keeps the other remembered views', () => {
    const memory = run(
      { type: 'go', projectId: 'p1', target: { view: 'general', message: 'm1' } },
      { type: 'applyRoute', projectId: 'p1', location: { place: { view: 'board' }, inspector: [task('r2')] } },
    )
    expect(locationOf(memory, 'p1')).toEqual({ place: { view: 'board' }, inspector: [task('r2')] })
    expect(memory.workspaces.p1.views.general).toEqual({ place: { view: 'general', message: 'm1' }, inspector: [] })
    // The same route again changes nothing.
    expect(locationReducer(memory, {
      type: 'applyRoute', projectId: 'p1', location: { place: { view: 'board' }, inspector: [task('r2')] },
    })).toBe(memory)
    const sessions = locationReducer(memory, {
      type: 'applyRoute', projectId: 'p1', location: { place: { view: 'sessions', conversation: 'c1' }, inspector: [task('r2')] },
    })
    expect(locationOf(sessions, 'p1')).toEqual({ place: { view: 'sessions', conversation: 'c1' }, inspector: [] })
  })

  it('forgets a Workspace that is entered fresh', () => {
    const memory = run(
      { type: 'go', projectId: 'p1', target: { view: 'board' } },
      { type: 'enterWorkspace', projectId: 'p2' },
      { type: 'enterWorkspace', projectId: 'p1', fresh: true },
    )
    expect(memory.lastProjectId).toBe('p1')
    expect(locationOf(memory, 'p1')).toEqual(GENERAL)
  })

  it('stamps the Workspace entered, and changes nothing when it is already the last one without memory', () => {
    const memory = run(
      { type: 'go', projectId: 'p1', target: { view: 'board' } },
      { type: 'go', projectId: 'p2', target: { view: 'board' } },
    )
    const entered = locationReducer(memory, { type: 'enterWorkspace', projectId: 'p1' })
    expect(entered.workspaces.p1.at).toBe(entered.seq)
    expect(entered.workspaces.p1.at).toBeGreaterThan(entered.workspaces.p2.at)
    expect(entered.workspaces.p2).toBe(memory.workspaces.p2)
    const bare = run({ type: 'enterWorkspace', projectId: 'p3' })
    expect(locationReducer(bare, { type: 'enterWorkspace', projectId: 'p3' })).toBe(bare)
  })

  describe('reconciles a remembered place with what exists now', () => {
    it('turns a private conversation with a removed or unknown member into General', () => {
      const memory = run({ type: 'go', projectId: 'p1', target: { view: 'dm', member: 'm1' } })
      const removed = locationReducer(memory, {
        type: 'reconcile', projectId: 'p1', facts: { removedMemberIds: new Set(['m1']) },
      })
      expect(locationOf(removed, 'p1')).toEqual(GENERAL)
      expect(removed.workspaces.p1.views['dm:m1']).toBeUndefined()
      const unknown = locationReducer(memory, {
        type: 'reconcile', projectId: 'p1', facts: { memberIds: new Set(['m2']) },
      })
      expect(locationOf(unknown, 'p1')).toEqual(GENERAL)
      expect(locationReducer(memory, {
        type: 'reconcile', projectId: 'p1', facts: { memberIds: new Set(['m1']), removedMemberIds: new Set() },
      })).toBe(memory)
    })

    it('cuts a stack at the first removed member, in every view', () => {
      const memory = run(
        { type: 'go', projectId: 'p1', target: { view: 'members' }, inspector: [member('m1')] },
        { type: 'go', projectId: 'p1', target: { view: 'board' }, inspector: [task('r1'), member('m1'), task('r2')] },
        { type: 'go', projectId: 'p1', target: { view: 'dm', member: 'm2' } },
      )
      const next = locationReducer(memory, {
        type: 'reconcile', projectId: 'p1', facts: { removedMemberIds: new Set(['m1']) },
      })
      expect(next.workspaces.p1.views.board?.inspector).toEqual([task('r1')])
      expect(next.workspaces.p1.views.members?.inspector).toEqual([])
      expect(locationOf(next, 'p1')).toEqual({ place: { view: 'dm', member: 'm2' }, inspector: [] })
    })

    it('turns a remembered Session that is not this Workspace’s into General', () => {
      const memory = run({ type: 'go', projectId: 'p1', target: { view: 'sessions', conversation: 'c9' } })
      const next = locationReducer(memory, {
        type: 'reconcile', projectId: 'p1', facts: { conversationIds: new Set(['c1']) },
      })
      expect(locationOf(next, 'p1')).toEqual(GENERAL)
      // Left behind, it is simply forgotten.
      const away = run(
        { type: 'go', projectId: 'p1', target: { view: 'sessions', conversation: 'c9' } },
        { type: 'go', projectId: 'p1', target: { view: 'board' } },
        { type: 'reconcile', projectId: 'p1', facts: { conversationIds: new Set(['c1']) } },
      )
      expect(locationOf(away, 'p1')).toEqual({ place: { view: 'board' }, inspector: [] })
      expect(away.workspaces.p1.views.sessions).toBeUndefined()
      expect(locationReducer(memory, {
        type: 'reconcile', projectId: 'p1', facts: { conversationIds: new Set(['c9']) },
      })).toBe(memory)
    })

    it('forgets a remembered Session that was removed, and turns it into General while on screen', () => {
      const memory = run(
        { type: 'go', projectId: 'p1', target: { view: 'general', message: 'm4' } },
        { type: 'go', projectId: 'p1', target: { view: 'sessions', conversation: 'c1' } },
      )
      const next = locationReducer(memory, {
        type: 'reconcile', projectId: 'p1', facts: { removedConversationIds: new Set(['c1']) },
      })
      expect(locationOf(next, 'p1')).toEqual({ place: { view: 'general', message: 'm4' }, inspector: [] })
      expect(next.workspaces.p1.views.sessions).toBeUndefined()
      expect(locationReducer(memory, {
        type: 'reconcile', projectId: 'p1', facts: { removedConversationIds: new Set(['c2']) },
      })).toBe(memory)
    })

    it('turns a current private conversation remembered only by its key into General', () => {
      const memory: LocationMemory = {
        lastProjectId: 'p1', seq: 1, workspaces: { p1: { current: 'dm:m1', views: {}, at: 1 } },
      }
      const next = locationReducer(memory, {
        type: 'reconcile', projectId: 'p1', facts: { removedMemberIds: new Set(['m1']) },
      })
      expect(locationOf(next, 'p1')).toEqual(GENERAL)
    })

    it('changes nothing for a Workspace it does not remember', () => {
      expect(locationReducer(EMPTY_MEMORY, {
        type: 'reconcile', projectId: 'p1', facts: { removedMemberIds: new Set(['m1']) },
      })).toBe(EMPTY_MEMORY)
    })
  })

  it('forgets unregistered Workspaces and the last one if it is among them', () => {
    const memory = run(
      { type: 'go', projectId: 'p1', target: { view: 'board' } },
      { type: 'go', projectId: 'p2', target: { view: 'board' } },
      { type: 'enterWorkspace', projectId: 'p2' },
    )
    const forgotten = locationReducer(memory, { type: 'forgetWorkspace', projectId: 'p2' })
    expect(forgotten.workspaces.p2).toBeUndefined()
    expect(forgotten.lastProjectId).toBeNull()
    expect(locationReducer(forgotten, { type: 'forgetWorkspace', projectId: 'p2' })).toBe(forgotten)
    const pruned = locationReducer(memory, { type: 'prune', projectIds: ['p1'] })
    expect(Object.keys(pruned.workspaces)).toEqual(['p1'])
    expect(pruned.lastProjectId).toBeNull()
    expect(locationReducer(memory, { type: 'prune', projectIds: ['p1', 'p2'] })).toBe(memory)
    const kept = locationReducer(memory, { type: 'forgetWorkspace', projectId: 'p1' })
    expect(kept.lastProjectId).toBe('p2')
  })

  it('remembers a bounded number of views, private conversations and questions first to go, General never', () => {
    let memory = run({ type: 'go', projectId: 'p1', target: { view: 'general', message: 'm1' } })
    for (const view of ['board', 'resources', 'members', 'sessions'] as const) {
      memory = locationReducer(memory, { type: 'go', projectId: 'p1', target: { view } })
    }
    for (let index = 0; index < 10; index += 1) {
      memory = locationReducer(memory, {
        type: 'go', projectId: 'p1', target: index % 2 ? { view: 'dm', member: `m${index}` } : { view: 'question', question: `q${index}` },
      })
    }
    const keys = Object.keys(memory.workspaces.p1.views)
    expect(keys).toHaveLength(MAX_REMEMBERED_VIEWS)
    expect(keys).toEqual(expect.arrayContaining(['general', 'board', 'resources', 'members', 'sessions', 'question:q8', 'dm:m9']))
    expect(keys).not.toContain('question:q0')
    expect(keys).not.toContain('dm:m1')
    expect(keys).not.toContain('question:q2')
    expect(memory.workspaces.p1.views.general?.place).toEqual({ view: 'general', message: 'm1' })
  })

  it('remembers a bounded number of Workspaces, the least recently used first to go', () => {
    let memory = EMPTY_MEMORY
    for (let index = 0; index <= MAX_REMEMBERED_WORKSPACES; index += 1) {
      memory = locationReducer(memory, { type: 'go', projectId: `p${index}`, target: { view: 'board' } })
    }
    expect(Object.keys(memory.workspaces)).toHaveLength(MAX_REMEMBERED_WORKSPACES)
    expect(memory.workspaces.p0).toBeUndefined()
    expect(memory.workspaces[`p${MAX_REMEMBERED_WORKSPACES}`]).toBeDefined()
    expect(capMemory(memory)).toBe(memory)
  })

  it('counts every write and leaves untouched branches as they were', () => {
    const memory = run(
      { type: 'go', projectId: 'p1', target: { view: 'general' } },
      { type: 'go', projectId: 'p2', target: { view: 'board' } },
    )
    expect(memory.seq).toBe(2)
    const next = locationReducer(memory, { type: 'inspect', projectId: 'p1', entry: task('r1'), mode: 'reset' })
    expect(next.seq).toBe(3)
    expect(next.workspaces.p1.at).toBe(3)
    expect(next.workspaces.p2).toBe(memory.workspaces.p2)
    // Choosing the destination already on screen is no change.
    expect(locationReducer(next, { type: 'go', projectId: 'p1', target: { view: 'general' } })).toBe(next)
    expect(locationReducer(next, { type: 'inspect', projectId: 'p1', entry: task('r1'), mode: 'push' })).toBe(next)
    const board = locationReducer(next, { type: 'go', projectId: 'p1', target: { view: 'board' } })
    expect(board.workspaces.p1.views.general).toBe(next.workspaces.p1.views.general)
  })

  it('names views and the places that host an inspector', () => {
    expect(viewKeyOf({ view: 'general', message: 'm1' })).toBe('general')
    expect(viewKeyOf({ view: 'dm', member: 'm1' })).toBe('dm:m1')
    expect(viewKeyOf({ view: 'question', question: 'q1' })).toBe('question:q1')
    expect(viewKeyOf({ view: 'sessions', conversation: null })).toBe('sessions')
    for (const view of ['general', 'board', 'resources', 'members'] as const) {
      expect(hostsInspector({ view })).toBe(true)
    }
    expect(hostsInspector({ view: 'dm', member: 'm1' })).toBe(true)
    expect(hostsInspector({ view: 'sessions' })).toBe(false)
    expect(hostsInspector({ view: 'question', question: 'q1' })).toBe(false)
  })

  it('reads a view remembered without its location from its key', () => {
    const memory: LocationMemory = {
      lastProjectId: 'p1',
      seq: 1,
      workspaces: { p1: { current: 'dm:m1', views: {}, at: 1 } },
    }
    expect(locationOf(memory, 'p1')).toEqual({ place: { view: 'dm', member: 'm1' }, inspector: [] })
    expect(locationOf({ ...memory, workspaces: { p1: { current: 'question:q1', views: {}, at: 1 } } }, 'p1'))
      .toEqual({ place: { view: 'question', question: 'q1' }, inspector: [] })
    expect(locationOf({ ...memory, workspaces: { p1: { current: 'members', views: {}, at: 1 } } }, 'p1'))
      .toEqual({ place: { view: 'members' }, inspector: [] })
  })

  describe('picks the Workspace to start in', () => {
    const projects = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]
    const memory: LocationMemory = { ...EMPTY_MEMORY, lastProjectId: 'p2' }

    it('prefers a link, then the last Workspace, then the first', () => {
      expect(pickInitialWorkspace(projects, { project: 'p3', view: 'general' }, memory)).toBe('p3')
      expect(pickInitialWorkspace(projects, null, memory)).toBe('p2')
      expect(pickInitialWorkspace(projects, null, EMPTY_MEMORY)).toBe('p1')
      expect(pickInitialWorkspace([], null, memory)).toBeNull()
    })

    it('ignores a link to an unknown Project and a stale last Workspace', () => {
      expect(pickInitialWorkspace(projects, { project: 'gone', view: 'general' }, memory)).toBe('p2')
      expect(pickInitialWorkspace(projects, { project: null, view: 'general' }, memory)).toBe('p2')
      expect(pickInitialWorkspace(projects, null, { ...EMPTY_MEMORY, lastProjectId: 'gone' })).toBe('p1')
    })
  })
})
