import { act, render } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useWorkspaceRouteSync } from './useWorkspaceRouteSync'
import type { WorkspaceRoute } from './workspaceRoute'

let setRoute: (route: WorkspaceRoute) => void = () => undefined
const applied: WorkspaceRoute[] = []

function Probe({ ready = true, delayed = false }: { ready?: boolean; delayed?: boolean }) {
  const [route, set] = useState<WorkspaceRoute>({ project: 'p1', view: 'sessions' })
  useEffect(() => { setRoute = set }, [set])
  useWorkspaceRouteSync({
    ready,
    current: route,
    apply: (next) => {
      applied.push(next)
      if (!delayed) set(next)
    },
  })
  return <output>{route.view}</output>
}

beforeEach(() => {
  applied.length = 0
  window.history.replaceState(null, '', '/user/alice/kubecode/')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useWorkspaceRouteSync', () => {
  it('writes where the researcher is, under the base path, and does not change the path', () => {
    render(<Probe />)
    expect(window.location.pathname).toBe('/user/alice/kubecode/')
    expect(window.location.hash).toBe('#/p/p1/sessions')
  })

  it('applies a link on first load instead of overwriting it', () => {
    window.history.replaceState(null, '', '/user/alice/kubecode/#/p/p1/general/m/msg-1?task=r1')
    render(<Probe />)
    expect(applied).toEqual([{ project: 'p1', view: 'general', message: 'msg-1', task: 'r1' }])
    expect(window.location.hash).toBe('#/p/p1/general/m/msg-1?task=r1')
  })

  it('waits until the shell is ready, and ignores a damaged link', () => {
    window.history.replaceState(null, '', '/#/p/p1/nonsense')
    const view = render(<Probe ready={false} />)
    expect(window.location.hash).toBe('#/p/p1/nonsense')
    view.rerender(<Probe ready />)
    expect(applied).toEqual([])
    expect(window.location.hash).toBe('#/p/p1/sessions')
  })

  it('pushes a history entry per change, and Back applies the earlier one', () => {
    render(<Probe />)
    const before = window.history.length
    act(() => setRoute({ project: 'p1', view: 'general' }))
    act(() => setRoute({ project: 'p1', view: 'board', task: 'r1' }))
    expect(window.location.hash).toBe('#/p/p1/board?task=r1')
    expect(window.history.length).toBe(before + 2)
    act(() => {
      window.history.replaceState(null, '', '#/p/p1/general')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(applied.at(-1)).toEqual({ project: 'p1', view: 'general' })
    // The applied place is not written back as a new entry.
    expect(window.history.length).toBe(before + 2)
  })

  it('does not overwrite a requested place with the states it passes through', () => {
    vi.useFakeTimers()
    window.history.replaceState(null, '', '/#/p/p2/general')
    const view = render(<Probe delayed />)
    // The Project is still loading: the shell shows something else meanwhile.
    act(() => setRoute({ project: 'p2', view: 'sessions' }))
    expect(window.location.hash).toBe('#/p/p2/general')
    // It arrives.
    act(() => setRoute({ project: 'p2', view: 'general' }))
    act(() => setRoute({ project: 'p2', view: 'board' }))
    expect(window.location.hash).toBe('#/p/p2/board')
    view.unmount()
  })

  it('gives up on a place that cannot be reached and shows where it is', () => {
    vi.useFakeTimers()
    window.history.replaceState(null, '', '/#/p/gone/general')
    render(<Probe delayed />)
    act(() => vi.advanceTimersByTime(5_000))
    act(() => setRoute({ project: 'p1', view: 'board' }))
    expect(window.location.hash).toBe('#/p/p1/board')
  })
})
