import { describe, expect, it } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import type { ChannelThread, Conversation, ProjectContextItem, ResearchSummary } from '../api'
import { localReferenceLabels, objectKindOf } from './referenceLabels'

const t = createTranslator('en')

describe('localReferenceLabels', () => {
  const labels = localReferenceLabels({
    research: [{ id: 'r1', title: 'Structured pruning' } as ResearchSummary],
    threads: [{ id: 't1', title: 'Should we prune?' } as ChannelThread],
    sessions: [{ id: 's1', title: 'Sweep run' } as Conversation],
    picked: [{ ref: { kind: 'artifact', id: 'a1', revision: 'v2' }, title: 'results.csv' } as ProjectContextItem],
    t,
  })

  it('names what this Workspace already knows by its title', () => {
    expect(labels({ kind: 'research', id: 'r1' })).toEqual({ kind: 'task', kindLabel: 'Task', title: 'Structured pruning' })
    expect(labels({ kind: 'thread', id: 't1' })).toMatchObject({ kind: 'thread', title: 'Should we prune?' })
    expect(labels({ kind: 'session', id: 's1' })).toMatchObject({ kind: 'session', title: 'Sweep run' })
    expect(labels({ kind: 'artifact', id: 'a1' })).toMatchObject({ kind: 'artifact', kindLabel: 'Artifact', title: 'results.csv' })
  })

  it('says it has no title instead of showing an id', () => {
    const label = labels({ kind: 'artifact', id: '064a23dd-0000' })
    expect(label.title).toBe('Artifact (no title)')
    expect(label.title).not.toContain('064a23dd')
    expect(labels({ kind: 'research', id: '064a23dd' }).title).toBe('Task (no title)')
  })
})

describe('objectKindOf', () => {
  it('gives every reference kind one of the shared glyphs', () => {
    expect(objectKindOf('research')).toBe('task')
    expect(objectKindOf('round')).toBe('task')
    expect(objectKindOf('import')).toBe('discussion')
    expect(objectKindOf('finding')).toBe('finding')
    expect(objectKindOf('session_turn')).toBe('session')
    expect(objectKindOf('team')).toBe('session')
    expect(objectKindOf('team_task')).toBe('workItem')
    expect(objectKindOf('work')).toBe('workItem')
    expect(objectKindOf('experiment')).toBe('experiment')
    expect(objectKindOf('artifact')).toBe('artifact')
    expect(objectKindOf('thread')).toBe('thread')
    expect(objectKindOf('channel')).toBe('message')
  })
})
