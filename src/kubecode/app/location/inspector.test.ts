import { describe, expect, it } from 'vitest'

import {
  applyInspect,
  entryKey,
  isRoutable,
  MAX_INSPECTOR_DEPTH,
  parentTaskOf,
  popEntry,
  routablePrefix,
  sameEntry,
  type InspectorEntry,
  type InspectorStack,
} from './inspector'

const task = (id: string): InspectorEntry => ({ kind: 'task', id })
const member = (id: string): InspectorEntry => ({ kind: 'member', id })
const artifact = (id: string, revision: string | null = null): InspectorEntry => (
  { kind: 'evidence', ref: { kind: 'artifact', id, revision } }
)
const file = (id: string): InspectorEntry => ({ kind: 'evidence', ref: { kind: 'file', id } })
const finding = (id: string): InspectorEntry => ({ kind: 'resource', ref: { kind: 'finding', id } })

describe('inspector stack', () => {
  it('resets, pushes and replaces', () => {
    const stack: InspectorStack = [task('r1'), artifact('a1')]
    expect(applyInspect(stack, member('m1'), 'reset')).toEqual([member('m1')])
    expect(applyInspect(stack, member('m1'), 'push')).toEqual([task('r1'), artifact('a1'), member('m1')])
    expect(applyInspect(stack, artifact('a2'), 'replace')).toEqual([task('r1'), artifact('a2')])
    expect(applyInspect([], artifact('a2'), 'replace')).toEqual([artifact('a2')])
    expect(applyInspect([], task('r1'), 'push')).toEqual([task('r1')])
  })

  it('returns to an entry already in the stack instead of cycling', () => {
    const stack: InspectorStack = [task('r1'), member('m1')]
    expect(applyInspect(stack, task('r1'), 'push')).toEqual([task('r1')])
    expect(applyInspect([task('r1'), artifact('a1'), member('m1')], task('r1'), 'replace')).toEqual([task('r1')])
  })

  it('keeps the very same stack when nothing changes', () => {
    const stack: InspectorStack = [task('r1'), member('m1')]
    expect(applyInspect(stack, member('m1'), 'push')).toBe(stack)
    expect(applyInspect(stack, { kind: 'member', id: 'm1' }, 'replace')).toBe(stack)
    const single: InspectorStack = [task('r1')]
    expect(applyInspect(single, task('r1'), 'reset')).toBe(single)
    expect(popEntry([])).toEqual([])
  })

  it('replaces the top once the stack is four deep, and closes when the last entry pops', () => {
    const full: InspectorStack = [task('r1'), artifact('a1'), member('m1'), finding('f1')]
    expect(full).toHaveLength(MAX_INSPECTOR_DEPTH)
    expect(applyInspect(full, member('m2'), 'push')).toEqual([task('r1'), artifact('a1'), member('m1'), member('m2')])
    expect(popEntry(full)).toEqual([task('r1'), artifact('a1'), member('m1')])
    expect(popEntry([task('r1')])).toEqual([])
  })

  it('keys entries stably by what they point at', () => {
    expect(entryKey(task('r1'))).toBe('task:r1')
    expect(entryKey(member('m1'))).toBe('member:m1')
    expect(entryKey(artifact('a1', 'rev'))).toBe('evidence:artifact:a1@rev')
    expect(entryKey(artifact('a1'))).toBe('evidence:artifact:a1')
    expect(entryKey({ kind: 'evidence', ref: { kind: 'artifact', id: 'a1' } })).toBe('evidence:artifact:a1')
    expect(entryKey(finding('f1'))).toBe('resource:finding:f1')
    expect(sameEntry(artifact('a1'), { kind: 'evidence', ref: { kind: 'artifact', id: 'a1' } })).toBe(true)
    expect(sameEntry(artifact('a1', 'x'), artifact('a1', 'y'))).toBe(false)
    expect(sameEntry(task('a1'), member('a1'))).toBe(false)
  })

  it('routes only ids: files and unsafe ids or revisions are not routable', () => {
    expect(isRoutable(task('r1'))).toBe(true)
    expect(isRoutable(member('m:1'))).toBe(true)
    expect(isRoutable(artifact('a1', '3f2c'))).toBe(true)
    expect(isRoutable(finding('f1'))).toBe(true)
    expect(isRoutable(file('results.csv'))).toBe(false)
    expect(isRoutable(task('a/b'))).toBe(false)
    expect(isRoutable(member(''))).toBe(false)
    expect(isRoutable(artifact('a1', 'bad rev'))).toBe(false)
    expect(isRoutable({ kind: 'resource', ref: { kind: 'file', id: 'notes.md' } })).toBe(false)
    expect(isRoutable({ kind: 'resource', ref: { kind: 'bogus' as never, id: 'x' } })).toBe(false)
  })

  it('writes the routable prefix only', () => {
    const stack: InspectorStack = [task('r1'), file('results.csv'), member('m1')]
    expect(routablePrefix(stack)).toEqual([task('r1')])
    const routable: InspectorStack = [task('r1'), artifact('a1')]
    expect(routablePrefix(routable)).toBe(routable)
    expect(routablePrefix([file('x.csv')])).toEqual([])
  })

  it('finds the Task an entry was opened from', () => {
    const stack: InspectorStack = [task('r1'), artifact('a1'), member('m1'), task('r2')]
    expect(parentTaskOf(stack, 0)).toBeNull()
    expect(parentTaskOf(stack, 1)).toBe('r1')
    expect(parentTaskOf(stack, 2)).toBe('r1')
    expect(parentTaskOf(stack, 3)).toBe('r1')
    expect(parentTaskOf([member('m1'), artifact('a1')], 1)).toBeNull()
  })
})
