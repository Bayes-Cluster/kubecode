import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreferenceStorage } from '../../preferenceStorage'
import { LOCATION_STORAGE_KEY } from './locationStorage'
import { LOCATION_WRITE_DELAY_MS, useWorkspaceLocation } from './useWorkspaceLocation'

function memoryStorage(initial: Record<string, string> = {}): PreferenceStorage & { values: Record<string, string>; writes: number } {
  const values = { ...initial }
  const storage = {
    values,
    writes: 0,
    getItem: (key: string) => values[key] ?? null,
    setItem: (key: string, value: string) => {
      storage.writes += 1
      values[key] = value
    },
  }
  return storage
}

function stored(storage: { values: Record<string, string> }) {
  return JSON.parse(storage.values[LOCATION_STORAGE_KEY]) as { workspaces: Record<string, { current: string; views: Record<string, string> }> }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('useWorkspaceLocation', () => {
  it('starts from the stored places, and a Workspace it does not know is on General', () => {
    const storage = memoryStorage({
      [LOCATION_STORAGE_KEY]: JSON.stringify({
        lastProjectId: 'p1',
        seq: 3,
        workspaces: { p1: { current: 'board', at: 3, views: { board: '/p/p1/board?task=r1' } } },
      }),
    })
    const { rerender, result } = renderHook(({ projectId }) => useWorkspaceLocation(projectId, storage), {
      initialProps: { projectId: 'p1' as string | null },
    })
    expect(result.current.location).toEqual({ place: { view: 'board' }, inspector: [{ kind: 'task', id: 'r1' }] })
    expect(result.current.peek().lastProjectId).toBe('p1')
    rerender({ projectId: 'p2' })
    expect(result.current.location).toEqual({ place: { view: 'general' }, inspector: [] })
  })

  it('writes what changed once the moves settle, and at once when the page is hidden', () => {
    const storage = memoryStorage()
    const { result } = renderHook(() => useWorkspaceLocation('p1', storage))
    act(() => result.current.dispatch({ type: 'go', projectId: 'p1', target: { view: 'board' } }))
    act(() => result.current.dispatch({ type: 'go', projectId: 'p1', target: { view: 'resources' } }))
    expect(storage.writes).toBe(0)
    act(() => { vi.advanceTimersByTime(LOCATION_WRITE_DELAY_MS) })
    expect(storage.writes).toBe(1)
    expect(stored(storage).workspaces.p1.current).toBe('resources')

    act(() => result.current.dispatch({ type: 'go', projectId: 'p1', target: { view: 'members' } }))
    act(() => { window.dispatchEvent(new Event('pagehide')) })
    expect(stored(storage).workspaces.p1.current).toBe('members')
  })

  it('never writes the places it only read', () => {
    const storage = memoryStorage()
    renderHook(() => useWorkspaceLocation('p1', storage))
    act(() => { vi.advanceTimersByTime(LOCATION_WRITE_DELAY_MS * 2) })
    act(() => { window.dispatchEvent(new Event('pagehide')) })
    expect(storage.writes).toBe(0)
  })

  it('reports a quiet change once, and a move that changes nothing on screen leaves the next one a new entry', () => {
    const { result } = renderHook(() => useWorkspaceLocation('p1', null))
    expect(result.current.takeHistoryMode()).toBe('push')
    act(() => result.current.dispatch(
      { type: 'go', projectId: 'p1', target: { view: 'general', message: 'm1' } },
      { history: 'replace' },
    ))
    expect(result.current.takeHistoryMode()).toBe('replace')
    expect(result.current.takeHistoryMode()).toBe('push')

    // A quiet change to another Workspace's memory is not a change of the address.
    act(() => result.current.dispatch(
      { type: 'go', projectId: 'p2', target: { view: 'board' } },
      { history: 'replace' },
    ))
    expect(result.current.takeHistoryMode()).toBe('push')

    // A move and a quiet change in one go: the move wins.
    act(() => {
      result.current.dispatch({ type: 'go', projectId: 'p1', target: { view: 'board' } })
      result.current.dispatch({ type: 'go', projectId: 'p1', target: { view: 'resources' } }, { history: 'replace' })
    })
    expect(result.current.takeHistoryMode()).toBe('push')
  })

  it('leaves the open Session to the address: remembering it is never a change of the address', () => {
    const { result } = renderHook(() => useWorkspaceLocation('p1', null))
    act(() => result.current.dispatch({ type: 'go', projectId: 'p1', target: { view: 'sessions' } }))
    expect(result.current.takeHistoryMode()).toBe('push')
    act(() => result.current.dispatch(
      { type: 'patchSessions', projectId: 'p1', conversation: 's1' },
      { history: 'replace' },
    ))
    expect(result.current.location.place).toEqual({ view: 'sessions', conversation: 's1' })
    // The address already named it, so nothing is left to make the next move quiet.
    expect(result.current.takeHistoryMode()).toBe('push')
  })

  it('knows whether the researcher moved, so their choice wins over a slow link', () => {
    const { result } = renderHook(() => useWorkspaceLocation('p1', null))
    expect(result.current.userMoved).toBe(false)
    act(() => result.current.dispatch({ type: 'enterWorkspace', projectId: 'p1' }))
    expect(result.current.userMoved).toBe(false)
    act(() => result.current.dispatch({ type: 'go', projectId: 'p1', target: { view: 'general' } }, { user: true }))
    expect(result.current.userMoved).toBe(true)
  })

  it('keeps a stable dispatch, and an unchanged memory keeps its identity', () => {
    const { result } = renderHook(() => useWorkspaceLocation('p1', null))
    const { dispatch, memory } = result.current
    act(() => dispatch({ type: 'inspectorClose', projectId: 'p1' }))
    expect(result.current.dispatch).toBe(dispatch)
    expect(result.current.memory).toBe(memory)
  })
})
