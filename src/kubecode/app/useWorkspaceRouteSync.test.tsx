import { act, render, screen } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { APPLY_TIMEOUT_MS, useWorkspaceRouteSync, type HistoryMode } from './useWorkspaceRouteSync'
import type { WorkspaceRoute } from './workspaceRoute'

let setRoute: (route: WorkspaceRoute) => void = () => undefined
const applied: WorkspaceRoute[] = []

function Probe({
  ready = true,
  delayed = false,
  moved = false,
  reject = false,
  mode,
}: {
  ready?: boolean
  delayed?: boolean
  moved?: boolean
  /** The shell cannot honour the route (an unknown Project). */
  reject?: boolean
  mode?: HistoryMode
}) {
  const [route, set] = useState<WorkspaceRoute>({ project: 'p1', view: 'sessions' })
  useEffect(() => { setRoute = set }, [set])
  const { pending } = useWorkspaceRouteSync({
    ready,
    ignoreInitialLink: moved,
    current: route,
    historyMode: mode ? () => mode : undefined,
    apply: (next) => {
      applied.push(next)
      if (reject) return false
      if (!delayed) set(next)
      return true
    },
  })
  return <output data-pending={pending ? 'yes' : 'no'}>{route.view}</output>
}

function pending(): string | null {
  return screen.getByRole('status').getAttribute('data-pending')
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

  it('fills in the first Session of a Project without adding a history entry', () => {
    render(<Probe />)
    const before = window.history.length
    act(() => setRoute({ project: 'p1', view: 'sessions', conversation: 'c-9' }))
    expect(window.location.hash).toBe('#/p/p1/sessions/c/c-9')
    expect(window.history.length).toBe(before)
  })

  it('applies one Back once, although the browser reports it as popstate and hashchange', () => {
    render(<Probe delayed />)
    act(() => {
      window.history.replaceState(null, '', '#/p/p1/dm/m1')
      window.dispatchEvent(new PopStateEvent('popstate'))
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(applied).toEqual([{ project: 'p1', view: 'dm', member: 'm1' }])
  })

  it('writes the place the researcher is in once an unreachable request times out', () => {
    vi.useFakeTimers()
    window.history.replaceState(null, '', '/#/p/p1/general')
    render(<Probe delayed />)
    // Nothing arrives; later navigation must not be swallowed for long.
    act(() => vi.advanceTimersByTime(APPLY_TIMEOUT_MS + 100))
    expect(window.location.hash).toBe('#/p/p1/sessions')
  })

  it('treats the requested view as reached even when the state carries fewer details', () => {
    window.history.replaceState(null, '', '/#/p/p1/dm/m1?task=x')
    render(<Probe delayed />)
    act(() => setRoute({ project: 'p1', view: 'dm', member: 'm1' }))
    expect(window.location.hash).toBe('#/p/p1/dm/m1')
    act(() => setRoute({ project: 'p1', view: 'board' }))
    expect(window.location.hash).toBe('#/p/p1/board')
  })

  it('lets what the researcher chose before the address was read win over the link they opened', () => {
    window.history.replaceState(null, '', '/#/p/p1/resources')
    render(<Probe moved />)
    expect(applied).toEqual([])
    expect(window.location.hash).toBe('#/p/p1/sessions')
  })

  it('is pending while a link is not reached yet, and settles once it arrives', () => {
    window.history.replaceState(null, '', '/#/p/p2/general')
    const view = render(<Probe ready={false} delayed />)
    // The address holds a link the shell has not reached: nothing else may show.
    expect(pending()).toBe('yes')
    view.rerender(<Probe ready delayed />)
    expect(pending()).toBe('yes')
    act(() => setRoute({ project: 'p2', view: 'general' }))
    expect(pending()).toBe('no')
  })

  it('is not pending without a link', () => {
    render(<Probe ready={false} />)
    expect(pending()).toBe('no')
  })

  it('is not pending when the link already names where the researcher is', () => {
    window.history.replaceState(null, '', '/#/p/p1/sessions')
    render(<Probe delayed />)
    expect(applied).toEqual([])
    expect(pending()).toBe('no')
  })

  it('is not pending once the researcher moved before the link was read', () => {
    window.history.replaceState(null, '', '/#/p/p1/resources')
    const view = render(<Probe ready={false} />)
    view.rerender(<Probe ready moved />)
    expect(applied).toEqual([])
    expect(pending()).toBe('no')
  })

  it('abandons a link the shell cannot honour at once, without waiting for the timeout', () => {
    vi.useFakeTimers()
    window.history.replaceState(null, '', '/#/p/gone/general')
    const before = window.history.length
    render(<Probe reject />)
    expect(applied).toEqual([{ project: 'gone', view: 'general' }])
    expect(pending()).toBe('no')
    // The address names where the researcher is, in place of the dead link.
    expect(window.location.hash).toBe('#/p/p1/sessions')
    expect(window.history.length).toBe(before)
    act(() => setRoute({ project: 'p1', view: 'board' }))
    expect(window.location.hash).toBe('#/p/p1/board')
  })

  it('abandons a Back to a place that can no longer be honoured', () => {
    render(<Probe reject />)
    const before = window.history.length
    act(() => {
      window.history.replaceState(null, '', '#/p/gone/board')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(pending()).toBe('no')
    expect(window.location.hash).toBe('#/p/p1/sessions')
    expect(window.history.length).toBe(before)
    act(() => setRoute({ project: 'p1', view: 'general' }))
    expect(window.location.hash).toBe('#/p/p1/general')
  })

  it('is pending while a Back is being reached', () => {
    render(<Probe delayed />)
    act(() => {
      window.history.replaceState(null, '', '#/p/p2/board')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(pending()).toBe('yes')
    act(() => setRoute({ project: 'p2', view: 'board' }))
    expect(pending()).toBe('no')
  })

  it('stops being pending when a link times out', () => {
    vi.useFakeTimers()
    window.history.replaceState(null, '', '/#/p/p2/general')
    render(<Probe delayed />)
    expect(pending()).toBe('yes')
    act(() => vi.advanceTimersByTime(APPLY_TIMEOUT_MS + 100))
    expect(pending()).toBe('no')
  })

  it('replaces the history entry when the shell asks for a quiet change', () => {
    render(<Probe mode="replace" />)
    const before = window.history.length
    act(() => setRoute({ project: 'p1', view: 'general', message: 'm9' }))
    expect(window.location.hash).toBe('#/p/p1/general/m/m9')
    expect(window.history.length).toBe(before)
  })

  it('pushes a history entry when the shell asks for one', () => {
    render(<Probe mode="push" />)
    const before = window.history.length
    act(() => setRoute({ project: 'p1', view: 'general' }))
    expect(window.location.hash).toBe('#/p/p1/general')
    expect(window.history.length).toBe(before + 1)
  })

  it('re-applies a Back from evidence to its Task once', () => {
    render(<Probe />)
    act(() => setRoute({ project: 'p1', view: 'general', task: 'r1' }))
    act(() => setRoute({
      project: 'p1',
      view: 'general',
      task: 'r1',
      inspect: [{ kind: 'evidence', ref: { kind: 'artifact', id: 'a1', revision: '3f' } }],
    }))
    expect(window.location.hash).toBe('#/p/p1/general?task=r1&inspect=evidence~artifact~a1~3f')
    const before = window.history.length
    applied.length = 0
    act(() => {
      window.history.replaceState(null, '', '#/p/p1/general?task=r1')
      window.dispatchEvent(new PopStateEvent('popstate'))
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(applied).toEqual([{ project: 'p1', view: 'general', task: 'r1' }])
    expect(screen.getByRole('status').textContent).toBe('general')
    expect(window.location.hash).toBe('#/p/p1/general?task=r1')
    expect(window.history.length).toBe(before)
  })
})
