import { describe, expect, it, vi } from 'vitest'

import en from '@/lib/locales/en.json'
import { createTranslator } from '@/lib/i18n'

import type { ProjectContextKind } from '../api'
import { fakeNavigation } from '../app/inspector/inspectorTesting'
import { PROJECT_CONTEXT_KIND_LABELS } from '../projectContext'
import { objectKindOf } from '../references/referenceLabels'
import {
  fallbackTitle,
  formatVersion,
  goToTargetFor,
  kindLabelKey,
  previewEntryFor,
  resourceFocusKey,
} from './referenceKinds'

const t = createTranslator('en')
const KINDS = Object.keys(PROJECT_CONTEXT_KIND_LABELS) as ProjectContextKind[]
const provenance = { author: null, updated_at: null, research_id: null, parent: null, state: null }

describe('reference kinds', () => {
  it('gives every kind, files included, a glyph and a label the catalog has', () => {
    expect(KINDS).toContain('file')
    for (const kind of KINDS) {
      expect(objectKindOf(kind)).toBeTruthy()
      expect(Object.keys(en)).toContain(kindLabelKey(kind))
    }
    expect(objectKindOf('file')).toBe('file')
    expect(t(kindLabelKey('research'))).toBe('Task')
    expect(t(kindLabelKey('file'))).toBe('File')
  })

  it('names a version in words and never shows a raw fingerprint', () => {
    expect(formatVersion('research', '3', t)).toBe('Brief v3')
    expect(formatVersion('finding', '1', t)).toBeUndefined()
    expect(formatVersion('file', 'large:9000000:1700000000', t)).toBe('Large file')
    expect(formatVersion('file', '3f2c1a9e5b7d4c6a8e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d', t)).toBe('#3f2c1a9')
    expect(formatVersion('thread', '0123456789abcdef', t)).toBe('#0123456')
    expect(formatVersion('work', '4', t)).toBe('v4')
    expect(formatVersion('artifact', 'not a revision', t)).toBeUndefined()
    expect(formatVersion('artifact', null, t)).toBeUndefined()
  })

  it('falls back to a file name or the kind, never to an id', () => {
    expect(fallbackTitle({ kind: 'file', id: 'results/summary.csv' }, t)).toBe('summary.csv')
    const untitled = fallbackTitle({ kind: 'artifact', id: '064a23dd-0000' }, t)
    expect(untitled).toBe('Artifact (no title)')
    expect(untitled).not.toContain('064a23dd')
  })

  it('keys a row by kind and id, the way the inspector returns focus', () => {
    expect(resourceFocusKey({ kind: 'finding', id: 'f1' })).toBe('resource:finding:f1')
  })

  it('previews a Task as a Task, unless a message is waiting for it, and everything else live', () => {
    expect(previewEntryFor({ kind: 'research', id: 'r1', revision: '3' })).toEqual({ kind: 'task', id: 'r1' })
    expect(previewEntryFor({ kind: 'research', id: 'r1' }, { attaching: true }))
      .toEqual({ kind: 'resource', ref: { kind: 'research', id: 'r1', revision: null } })
    expect(previewEntryFor({ kind: 'session', id: 's1', revision: 'x' }))
      .toEqual({ kind: 'resource', ref: { kind: 'session', id: 's1', revision: null } })
    expect(previewEntryFor({ kind: 'file', id: 'a.csv' }))
      .toEqual({ kind: 'resource', ref: { kind: 'file', id: 'a.csv', revision: null } })
  })

  it('offers to go where a record lives, only when it lives somewhere else', () => {
    const navigation = fakeNavigation()
    const task = goToTargetFor({ kind: 'finding', id: 'f1' }, { ...provenance, research_id: 'r1' })
    expect(task?.label).toBe('kubecode.resources.goTo.task')
    task?.run(navigation)
    expect(navigation.inspect).toHaveBeenCalledWith({ kind: 'task', id: 'r1' }, { mode: 'push' })

    const thread = goToTargetFor({ kind: 'thread', id: 't1' }, provenance)
    thread?.run(navigation)
    expect(navigation.openPlace).toHaveBeenCalledWith({ view: 'general', thread: 't1' }, { inspector: 'closed' })

    const session = goToTargetFor({ kind: 'session', id: 's1' }, provenance)
    session?.run(navigation)
    expect(navigation.openSession).toHaveBeenCalledWith('s1')

    expect(goToTargetFor({ kind: 'file', id: 'a.csv' }, provenance)).toBeNull()
    expect(goToTargetFor({ kind: 'research', id: 'r1' }, { ...provenance, research_id: 'r1' })?.label)
      .toBe('kubecode.resources.goTo.task')
    vi.restoreAllMocks()
  })
})
