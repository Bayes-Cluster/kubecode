import { describe, expect, it } from 'vitest'

import type { ProjectContextKind } from '../../api'
import { PROJECT_CONTEXT_KINDS } from '../../projectContext'
import { inspectorTargetForReference } from './references'

describe('references open the same way everywhere', () => {
  it('opens a Task in the inspector, a Thread or the channel in General, and a Session as history', () => {
    expect(inspectorTargetForReference({ kind: 'research', id: 'r1', revision: 'x' })).toEqual({
      inspect: { kind: 'task', id: 'r1' },
    })
    expect(inspectorTargetForReference({ kind: 'thread', id: 't1' })).toEqual({ place: { view: 'general', thread: 't1' } })
    expect(inspectorTargetForReference({ kind: 'channel', id: 'general' })).toEqual({ place: { view: 'general' } })
    expect(inspectorTargetForReference({ kind: 'session', id: 's1' })).toEqual({ session: 's1' })
  })

  it('opens a work item on Kanban with its Task, which only the work item knows', () => {
    expect(inspectorTargetForReference({ kind: 'work', id: 'w1', revision: null })).toEqual({ work: 'w1' })
  })

  it('opens every other record as a live resource', () => {
    const others = PROJECT_CONTEXT_KINDS.filter((kind) => !['research', 'thread', 'channel', 'session', 'work'].includes(kind))
    expect(others).toEqual([
      'round', 'import', 'finding', 'session_turn', 'team', 'team_task', 'experiment', 'artifact',
    ])
    for (const kind of others as ProjectContextKind[]) {
      expect(inspectorTargetForReference({ kind, id: 'x1', revision: 'rev' }), kind).toEqual({
        inspect: { kind: 'resource', ref: { kind, id: 'x1' } },
      })
    }
  })
})
