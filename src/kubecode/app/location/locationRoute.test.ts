import { describe, expect, it } from 'vitest'

import { parseWorkspaceRoute, routeHash } from '../workspaceRoute'
import type { InspectorEntry } from './inspector'
import {
  formatInspectorToken,
  locationFromRoute,
  parseInspectorToken,
  routeFromLocation,
} from './locationRoute'
import type { WorkspaceLocation } from './workspaceLocation'

const task = (id: string): InspectorEntry => ({ kind: 'task', id })
const member = (id: string): InspectorEntry => ({ kind: 'member', id })

function locationOfHash(hash: string): WorkspaceLocation {
  const route = parseWorkspaceRoute(hash)
  if (!route) throw new Error(`not a route: ${hash}`)
  return locationFromRoute(route)
}

/** Every link written under ADR 0224, the location it names, and back to the same hash. */
const GOLDEN: Array<[string, WorkspaceLocation]> = [
  ['#/p/P/sessions', { place: { view: 'sessions' }, inspector: [] }],
  ['#/p/P/sessions/c/C', { place: { view: 'sessions', conversation: 'C' }, inspector: [] }],
  ['#/p/P/general', { place: { view: 'general' }, inspector: [] }],
  ['#/p/P/general/m/M', { place: { view: 'general', message: 'M' }, inspector: [] }],
  ['#/p/P/general/m/M?task=T', { place: { view: 'general', message: 'M' }, inspector: [task('T')] }],
  ['#/p/P/general?filter=F', { place: { view: 'general', filter: 'F' }, inspector: [] }],
  ['#/p/P/general?thread=H', { place: { view: 'general', thread: 'H' }, inspector: [] }],
  ['#/p/P/general?task=T&thread=H', { place: { view: 'general', thread: 'H' }, inspector: [task('T')] }],
  [
    '#/p/P/general/m/M?task=T&filter=T&thread=H',
    { place: { view: 'general', message: 'M', filter: 'T', thread: 'H' }, inspector: [task('T')] },
  ],
  ['#/p/P/board', { place: { view: 'board' }, inspector: [] }],
  ['#/p/P/board?task=T', { place: { view: 'board' }, inspector: [task('T')] }],
  ['#/p/P/resources', { place: { view: 'resources' }, inspector: [] }],
  ['#/p/P/needs-you', { place: { view: 'needs-you' }, inspector: [] }],
  ['#/p/P/members', { place: { view: 'members' }, inspector: [] }],
  ['#/p/P/members?member=M', { place: { view: 'members' }, inspector: [member('M')] }],
  ['#/p/P/dm/M', { place: { view: 'dm', member: 'M' }, inspector: [] }],
  ['#/p/P/question/Q', { place: { view: 'question', question: 'Q' }, inspector: [] }],
]

describe('locations and routes', () => {
  it('reads every ADR 0224 link as its place and writes it back byte for byte', () => {
    for (const [hash, location] of GOLDEN) {
      expect(locationOfHash(hash), hash).toEqual(location)
      expect(routeHash(routeFromLocation('P', location)), hash).toBe(hash)
    }
  })

  it('reads a link without a project as a place in the active Workspace', () => {
    const route = parseWorkspaceRoute('#/general')
    expect(route).not.toBeNull()
    expect(locationFromRoute(route!)).toEqual({ place: { view: 'general' }, inspector: [] })
    expect(routeHash(routeFromLocation(null, { place: { view: 'general' }, inspector: [] }))).toBe('#/general')
  })

  it('round-trips deeper stacks', () => {
    const cases: Array<[string, WorkspaceLocation]> = [
      [
        '#/p/P/general/m/M?task=T&inspect=evidence~artifact~A1~3f2c',
        {
          place: { view: 'general', message: 'M' },
          inspector: [task('T'), { kind: 'evidence', ref: { kind: 'artifact', id: 'A1', revision: '3f2c' } }],
        },
      ],
      ['#/p/P/board?task=T&inspect=member~M', { place: { view: 'board' }, inspector: [task('T'), member('M')] }],
      [
        '#/p/P/resources?inspect=resource~finding~F1',
        { place: { view: 'resources' }, inspector: [{ kind: 'resource', ref: { kind: 'finding', id: 'F1' } }] },
      ],
      ['#/p/P/members?member=M&inspect=task~T', { place: { view: 'members' }, inspector: [member('M'), task('T')] }],
      ['#/p/P/dm/M?task=T&inspect=member~N', { place: { view: 'dm', member: 'M' }, inspector: [task('T'), member('N')] }],
      // A bottom entry without a legacy parameter is an inspect token too.
      ['#/p/P/board?inspect=member~M&inspect=task~T', { place: { view: 'board' }, inspector: [member('M'), task('T')] }],
      ['#/p/P/members?inspect=task~T', { place: { view: 'members' }, inspector: [task('T')] }],
    ]
    for (const [hash, location] of cases) {
      expect(locationOfHash(hash), hash).toEqual(location)
      expect(routeHash(routeFromLocation('P', location)), hash).toBe(hash)
    }
  })

  it('writes a stack with file evidence only up to the Task', () => {
    const location: WorkspaceLocation = {
      place: { view: 'general', message: 'M' },
      inspector: [task('T'), { kind: 'evidence', ref: { kind: 'file', id: 'results.csv' } }],
    }
    expect(routeHash(routeFromLocation('P', location))).toBe('#/p/P/general/m/M?task=T')
  })

  it('ignores inspector parameters where no inspector lives', () => {
    expect(locationOfHash('#/p/P/sessions?task=T&inspect=member~M')).toEqual({ place: { view: 'sessions' }, inspector: [] })
    expect(locationOfHash('#/p/P/question/Q?task=T&inspect=task~T2')).toEqual({
      place: { view: 'question', question: 'Q' }, inspector: [],
    })
    // Needs you opens each entry where it is answered.
    expect(locationOfHash('#/p/P/needs-you?task=T&inspect=member~M')).toEqual({ place: { view: 'needs-you' }, inspector: [] })
    // The app never wrote a Task on Members.
    expect(locationOfHash('#/p/P/members?task=T')).toEqual({ place: { view: 'members' }, inspector: [] })
    // Nor does it write one for Sessions, whatever the stack says.
    expect(routeHash(routeFromLocation('P', { place: { view: 'sessions' }, inspector: [task('T')] })))
      .toBe('#/p/P/sessions')
  })

  it('writes the open Session of the Sessions surface, or the remembered one', () => {
    const location: WorkspaceLocation = { place: { view: 'sessions', conversation: 'C1' }, inspector: [] }
    expect(routeHash(routeFromLocation('P', location))).toBe('#/p/P/sessions/c/C1')
    expect(routeHash(routeFromLocation('P', location, 'C2'))).toBe('#/p/P/sessions/c/C2')
    expect(routeHash(routeFromLocation('P', { place: { view: 'sessions' }, inspector: [] }, null))).toBe('#/p/P/sessions')
  })

  it('folds a duplicate entry back into the stack and keeps four entries at most', () => {
    expect(locationOfHash('#/p/P/board?task=T&inspect=member~M&inspect=task~T').inspector).toEqual([task('T')])
    expect(locationOfHash(
      '#/p/P/board?task=T&inspect=member~a&inspect=member~b&inspect=member~c&inspect=member~d',
    ).inspector).toEqual([task('T'), member('a'), member('b'), member('c')])
  })

  it('formats and parses single tokens', () => {
    expect(formatInspectorToken(task('T'))).toBe('task~T')
    expect(formatInspectorToken(member('M'))).toBe('member~M')
    expect(formatInspectorToken({ kind: 'evidence', ref: { kind: 'artifact', id: 'a1' } })).toBe('evidence~artifact~a1')
    expect(formatInspectorToken({ kind: 'resource', ref: { kind: 'finding', id: 'f1', revision: 'r' } }))
      .toBe('resource~finding~f1')
    expect(formatInspectorToken({ kind: 'evidence', ref: { kind: 'file', id: 'results.csv' } })).toBeNull()
    expect(parseInspectorToken('evidence~artifact~a1')).toEqual(
      { kind: 'evidence', ref: { kind: 'artifact', id: 'a1', revision: null } },
    )
    for (const bad of [
      '', 'task', 'task~', 'task~a~b', 'member~a/b', 'evidence~artifact', 'evidence~file~x',
      'evidence~artifact~a1~bad rev', 'evidence~artifact~a1~r~extra', 'resource~finding~f1~r', 'resource~bogus~f1',
      'thread~t1',
    ]) {
      expect(parseInspectorToken(bad), bad).toBeNull()
    }
  })

  it('treats a route naming no member or question as General', () => {
    expect(locationFromRoute({ project: 'P', view: 'dm' })).toEqual({ place: { view: 'general' }, inspector: [] })
    expect(locationFromRoute({ project: 'P', view: 'question' })).toEqual({ place: { view: 'general' }, inspector: [] })
  })
})
