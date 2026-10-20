import { describe, expect, it } from 'vitest'

import {
  formatWorkspaceRoute,
  parseWorkspaceRoute,
  routeHash,
  routesEqual,
  type WorkspaceRoute,
} from './workspaceRoute'

const routes: WorkspaceRoute[] = [
  { project: null, view: 'sessions' },
  { project: 'p1', view: 'sessions', conversation: 'c-1' },
  { project: 'p1', view: 'general' },
  { project: 'p1', view: 'general', message: 'msg-1', task: 'r1' },
  { project: 'p1', view: 'general', filter: 'r1', thread: 't1' },
  { project: 'p1', view: 'board' },
  { project: 'p1', view: 'board', task: 'r1' },
  { project: 'p1', view: 'resources' },
  { project: 'p1', view: 'members', member: 'm1' },
  { project: 'p1', view: 'dm', member: 'm1' },
  { project: 'p1', view: 'question', question: 'r1' },
]

describe('workspace routes', () => {
  it('round-trips every route through its hash', () => {
    for (const route of routes) {
      expect(parseWorkspaceRoute(routeHash(route))).toEqual(route)
    }
  })

  it('writes ids and view names only, never a path of the server', () => {
    expect(formatWorkspaceRoute({ project: 'p1', view: 'general', message: 'm1' }))
      .toBe('/p/p1/general/m/m1')
    expect(routeHash({ project: 'p1', view: 'board', task: 'r1' })).toBe('#/p/p1/board?task=r1')
  })

  it('refuses damaged, foreign, or unsafe routes instead of guessing', () => {
    for (const bad of [
      '', '#', '#/', '#nonsense', '#/nowhere', '#/p', '#/p/', '#/p/x', '#/p/x/unknown',
      '#/general/extra', '#/p/x/general/m', '#/p/x/general/m/', '#/p/x/dm', '#/p/x/question',
      '#/p/../general', '#/p/a%2Fb/general', '#/p/x/general/m/%E0%A4%A', '#/p/x/board/extra',
      '#/p/x/sessions/c', `#/p/x/general/m/${'a'.repeat(200)}`,
    ]) {
      expect(parseWorkspaceRoute(bad), bad).toBeNull()
    }
  })

  it('drops unsafe query values but keeps the route', () => {
    expect(parseWorkspaceRoute('#/p/x/general?task=a%2Fb&filter=ok')).toEqual({
      project: 'x', view: 'general', filter: 'ok',
    })
    // Parameters of other views are ignored.
    expect(parseWorkspaceRoute('#/p/x/board?filter=r1&thread=t')).toEqual({ project: 'x', view: 'board' })
  })

  it('compares routes by what they say', () => {
    expect(routesEqual(routes[3], { ...routes[3] })).toBe(true)
    expect(routesEqual(routes[3], routes[2])).toBe(false)
    expect(routesEqual(null, null)).toBe(true)
    expect(routesEqual(null, routes[0])).toBe(false)
  })

  it('writes every route of ADR 0224 byte for byte as before', () => {
    // The formatter of ADR 0224, kept as the reference: URLSearchParams for the query.
    const legacy = (route: WorkspaceRoute): string => {
      const parts: string[] = []
      if (route.project) parts.push('p', encodeURIComponent(route.project))
      parts.push(route.view)
      if (route.view === 'sessions' && route.conversation) parts.push('c', encodeURIComponent(route.conversation))
      if (route.view === 'general' && route.message) parts.push('m', encodeURIComponent(route.message))
      if (route.view === 'dm' && route.member) parts.push(encodeURIComponent(route.member))
      if (route.view === 'question' && route.question) parts.push(encodeURIComponent(route.question))
      const path = `/${parts.join('/')}`
      const query = new URLSearchParams()
      if (route.task) query.set('task', route.task)
      if (route.view === 'general' && route.filter) query.set('filter', route.filter)
      if (route.view === 'general' && route.thread) query.set('thread', route.thread)
      if (route.view === 'members' && route.member) query.set('member', route.member)
      const text = query.toString()
      return `${path}${text ? `?${text}` : ''}`
    }
    const odd = 'a:b.c_d-e:9'
    for (const route of [
      ...routes,
      { project: odd, view: 'general', message: odd, task: odd, filter: odd, thread: odd },
      { project: 'p1', view: 'board', task: 'task:01.x_y-z' },
      { project: 'p1', view: 'members', member: 'member:a.b' },
      { project: 'p1', view: 'sessions', conversation: odd },
    ] satisfies WorkspaceRoute[]) {
      expect(formatWorkspaceRoute(route), JSON.stringify(route)).toBe(legacy(route))
    }
    expect(formatWorkspaceRoute({ project: 'p1', view: 'board', task: 'a:b' })).toBe('/p/p1/board?task=a%3Ab')
  })

  it('writes inspector entries above the legacy one as readable, repeated inspect parameters', () => {
    const route: WorkspaceRoute = {
      project: 'P',
      view: 'general',
      message: 'M',
      task: 'T',
      inspect: [
        { kind: 'evidence', ref: { kind: 'artifact', id: 'a1', revision: '3f' } },
        { kind: 'member', id: 'm1' },
      ],
    }
    expect(routeHash(route)).toBe('#/p/P/general/m/M?task=T&inspect=evidence~artifact~a1~3f&inspect=member~m1')
    expect(parseWorkspaceRoute(routeHash(route))).toEqual(route)
    // A percent-encoded separator reads the same.
    expect(parseWorkspaceRoute('#/p/P/board?inspect=resource%7Efinding%7Ef1')).toEqual({
      project: 'P', view: 'board', inspect: [{ kind: 'resource', ref: { kind: 'finding', id: 'f1' } }],
    })
  })

  it('keeps the longest valid prefix of inspect parameters, at most four deep', () => {
    expect(parseWorkspaceRoute('#/p/x/board?inspect=task~r2&inspect=bogus&inspect=member~m1')).toEqual({
      project: 'x', view: 'board', inspect: [{ kind: 'task', id: 'r2' }],
    })
    expect(parseWorkspaceRoute('#/p/x/board?inspect=evidence~file~results.csv&inspect=task~r2')).toEqual({
      project: 'x', view: 'board',
    })
    expect(parseWorkspaceRoute('#/p/x/board?inspect=resource~nonsense~f1')).toEqual({ project: 'x', view: 'board' })
    expect(parseWorkspaceRoute('#/p/x/board?inspect=task~a%2Fb')).toEqual({ project: 'x', view: 'board' })
    const deep = parseWorkspaceRoute(
      '#/p/x/board?inspect=task~r1&inspect=member~m1&inspect=task~r2&inspect=member~m2&inspect=task~r3',
    )
    expect(deep?.inspect?.map((entry) => entry.kind === 'task' || entry.kind === 'member' ? entry.id : null))
      .toEqual(['r1', 'm1', 'r2', 'm2'])
  })

  it('never writes a file or anything above it', () => {
    expect(formatWorkspaceRoute({
      project: 'p1',
      view: 'general',
      task: 'r1',
      inspect: [
        { kind: 'evidence', ref: { kind: 'file', id: 'results.csv' } },
        { kind: 'member', id: 'm1' },
      ],
    })).toBe('/p/p1/general?task=r1')
    expect(formatWorkspaceRoute({
      project: 'p1',
      view: 'board',
      inspect: [
        { kind: 'task', id: 'r1' }, { kind: 'task', id: 'r2' }, { kind: 'task', id: 'r3' },
        { kind: 'task', id: 'r4' }, { kind: 'task', id: 'r5' },
      ],
    })).toBe('/p/p1/board?inspect=task~r1&inspect=task~r2&inspect=task~r3&inspect=task~r4')
  })
})
