import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { KubecodeApi, ProjectContextItem, ProjectContextKind, ProjectContextPage, WorkspaceEvent } from '../api'
import { createPlaceMemory } from '../app/location/placeMemory'
import { PlaceMemoryProvider } from '../app/location/PlaceMemoryProvider'
import { useWorkspaceSearch, type WorkspaceSearchOptions } from './useWorkspaceSearch'

const item = (kind: ProjectContextKind, id: string, title = id): ProjectContextItem => ({
  ref: { kind, id, revision: null },
  title,
  summary: '',
  provenance: { author: null, updated_at: null, research_id: null, parent: null, state: null },
  availability: 'available',
})

const page = (items: ProjectContextItem[], extra: Partial<ProjectContextPage> = {}): ProjectContextPage => ({
  items, next_cursor: null, truncated: false, searched: ['finding'], truncated_kinds: [], counts: { finding: items.length }, ...extra,
})

const event = (id: number, kind: string): WorkspaceEvent => ({
  id, kind, payload: {}, project_id: 'p1', conversation_id: null, run_id: null, created_at: '',
})

function setup(search: ReturnType<typeof vi.fn>, initial: Partial<WorkspaceSearchOptions> = {}, memory = createPlaceMemory()) {
  const api = { searchProjectContext: search } as unknown as KubecodeApi
  const wrapper = ({ children }: { children: ReactNode }) => <PlaceMemoryProvider memory={memory}>{children}</PlaceMemoryProvider>
  const options: WorkspaceSearchOptions = {
    api, projectId: 'p1', query: '', kinds: ['finding'], cacheKey: 'p1|view:resources', events: [], debounceMs: 0, ...initial,
  }
  const hook = renderHook((props: WorkspaceSearchOptions) => useWorkspaceSearch(props), { initialProps: options, wrapper })
  return { ...hook, options, memory }
}

describe('useWorkspaceSearch', () => {
  it('searches the kinds it is given, by name, and reports the scope the server searched', async () => {
    const search = vi.fn().mockResolvedValue(page([item('finding', 'f1')], { truncated: true, truncated_kinds: ['finding'] }))
    const { result } = setup(search)
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(search).toHaveBeenCalledWith('p1', expect.objectContaining({ query: '', kinds: ['finding'], signal: expect.any(AbortSignal) }))
    expect(result.current.results.map((entry) => entry.key)).toEqual(['finding:f1'])
    expect(result.current.searched).toEqual(['finding'])
    expect(result.current.truncatedKinds).toEqual(['finding'])
    expect(result.current.counts).toEqual({ finding: 1 })
  })

  it('searches nothing when no section is chosen', async () => {
    const search = vi.fn()
    const { result } = setup(search, { kinds: [] })
    expect(result.current.status).toBe('idle')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
    expect(search).not.toHaveBeenCalled()
  })

  it('waits for typing to pause, and drops an older response that lands late', async () => {
    let resolveOld: (value: ProjectContextPage) => void = () => undefined
    const search = vi.fn()
      .mockResolvedValueOnce(page([item('finding', 'f0')]))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
      .mockResolvedValueOnce(page([item('finding', 'f2', 'new')]))
    const { options, rerender, result } = setup(search, { debounceMs: 20 })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    rerender({ ...options, debounceMs: 20, query: 'o' })
    rerender({ ...options, debounceMs: 20, query: 'ol' })
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2))
    expect(search).toHaveBeenLastCalledWith('p1', expect.objectContaining({ query: 'ol' }))
    const aborted = (search.mock.calls[1][1] as { signal: AbortSignal }).signal
    rerender({ ...options, debounceMs: 20, query: 'new' })
    await waitFor(() => expect(result.current.results[0]?.key).toBe('finding:f2'))
    expect(aborted.aborted).toBe(true)
    await act(async () => resolveOld(page([item('finding', 'f1', 'old')])))
    expect(result.current.results.map((entry) => entry.key)).toEqual(['finding:f2'])
  })

  it('never keeps another Workspace’s results', async () => {
    let resolveFirst: (value: ProjectContextPage) => void = () => undefined
    const search = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockResolvedValue(page([item('finding', 'f9')]))
    const { options, rerender, result } = setup(search)
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1))
    rerender({ ...options, projectId: 'p2', cacheKey: 'p2|view:resources' })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    await act(async () => resolveFirst(page([item('finding', 'f1')])))
    expect(result.current.results.every((entry) => entry.projectId === 'p2')).toBe(true)
    expect(result.current.results.map((entry) => entry.key)).toEqual(['finding:f9'])
  })

  it('appends further pages without repeating a row, and keeps the rows when one fails', async () => {
    const search = vi.fn()
      .mockResolvedValueOnce(page([item('finding', 'f1')], { next_cursor: 'c1' }))
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(page([item('finding', 'f1'), item('finding', 'f2')]))
    const { result } = setup(search)
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.loadMoreFailed).toBe(true))
    expect(result.current.results).toHaveLength(1)
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.results.map((entry) => entry.key)).toEqual(['finding:f1', 'finding:f2']))
    expect(search).toHaveBeenLastCalledWith('p1', expect.objectContaining({ cursor: 'c1' }))
    expect(result.current.loadMoreFailed).toBe(false)
  })

  it('says a failed search failed, and tries again', async () => {
    const search = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(page([item('finding', 'f1')]))
    const { result } = setup(search)
    await waitFor(() => expect(result.current.status).toBe('error'))
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.status).toBe('ready'))
  })

  it('marks results stale on a relevant change, without searching again until asked', async () => {
    const search = vi.fn().mockResolvedValue(page([item('finding', 'f1')]))
    const { options, rerender, result } = setup(search)
    await waitFor(() => expect(result.current.status).toBe('ready'))
    rerender({ ...options, events: [event(1, 'channel_updated')] })
    expect(result.current.stale).toBe(false)
    rerender({ ...options, events: [event(1, 'channel_updated'), event(2, 'research_updated')] })
    expect(result.current.stale).toBe(true)
    expect(search).toHaveBeenCalledTimes(1)
    act(() => result.current.refresh())
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.stale).toBe(false))
  })

  it('shows the same search again at once after its view comes back', async () => {
    const memory = createPlaceMemory()
    const search = vi.fn().mockResolvedValue(page([item('finding', 'f1')]))
    const first = setup(search, {}, memory)
    await waitFor(() => expect(first.result.current.status).toBe('ready'))
    first.unmount()
    const again = setup(search, {}, memory)
    expect(again.result.current.status).toBe('ready')
    expect(again.result.current.results.map((entry) => entry.key)).toEqual(['finding:f1'])
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
    expect(search).toHaveBeenCalledTimes(1)
  })
})
