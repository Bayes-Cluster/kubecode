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
})
