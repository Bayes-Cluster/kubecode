import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { KubecodeApi, WorkspaceEvent } from './api'
import {
  useWorkspaceEventStream,
  type WorkspaceEventBatch,
  type WorkspaceEventReconciliationRequest,
} from './useWorkspaceEventStream'

class FakeEventSource {
  static instances: FakeEventSource[] = []
  onerror: ((event: Event) => void) | null = null
  onopen: ((event: Event) => void) | null = null
  readonly close = vi.fn()
  private listener: ((event: MessageEvent<string>) => void) | null = null

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(_type: string, listener: EventListener) {
    this.listener = listener as (event: MessageEvent<string>) => void
  }

  emit(event: unknown) {
    this.emitRaw(JSON.stringify(event))
  }

  emitRaw(data: string) {
    this.listener?.(new MessageEvent('workspace_event', { data }))
  }
}

describe('useWorkspaceEventStream', () => {
  let frames: Map<number, FrameRequestCallback>
  let nextFrame: number
  const api = {
    workspaceEventStreamUrl: vi.fn((after: number) => `/events?after=${after}`),
  } as unknown as KubecodeApi

  beforeEach(() => {
    FakeEventSource.instances = []
    frames = new Map()
    nextFrame = 1
    vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource)
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      const id = nextFrame++
      frames.set(id, callback)
      return id
    }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => {
      frames.delete(id)
    }))
  })

  afterEach(() => vi.unstubAllGlobals())

  function flushFrame() {
    const queued = [...frames.entries()]
    frames.clear()
    act(() => queued.forEach(([, callback]) => callback(16)))
  }

  it('flushes a 100-event burst once in durable order with one reconciliation plan', () => {
    const onBatch = vi.fn()
    const { result } = renderHook(() => useWorkspaceEventStream({
      activeProjectId: 'project-1',
      api,
      cursor: 0,
      onBatch,
    }))
    const stream = FakeEventSource.instances[0]

    act(() => {
      for (let id = 100; id >= 1; id -= 1) {
        const kinds = ['session_updated', 'team_task_updated', 'terminal_updated', 'run_started']
        stream?.emit(workspaceEvent(id, kinds[id % kinds.length] as string))
      }
    })
    expect(onBatch).not.toHaveBeenCalled()

    flushFrame()

    expect(onBatch).toHaveBeenCalledOnce()
    const batch = onBatch.mock.calls[0]?.[0] as WorkspaceEventBatch
    expect(batch.events).toHaveLength(100)
    expect(batch.events.map((event) => event.id)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1),
    )
    expect(batch.plan).toEqual({
      cleanTerminalIds: [],
      refreshGlobalSessions: true,
      refreshProjectRuns: false,
      refreshProjectSessions: true,
      refreshTeams: true,
      refreshTerminals: true,
    })
    expect(result.current.events.map((event) => event.id)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1),
    )
  })

  it('deduplicates across flushes and recovers after malformed JSON and schema input', () => {
    const onBatch = vi.fn()
    const { result } = renderHook(() => useWorkspaceEventStream({
      activeProjectId: 'project-1',
      api,
      cursor: 0,
      onBatch,
    }))
    const stream = FakeEventSource.instances[0]

    act(() => stream?.emitRaw('{'))
    expect(result.current.diagnostic?.code).toBe('invalid_json')
    act(() => stream?.emit({ id: 99, kind: 'run_started', payload: [] }))
    expect(result.current.diagnostic?.code).toBe('invalid_event')

    act(() => {
      stream?.emit(workspaceEvent(3, 'run_started'))
      stream?.emit(workspaceEvent(1, 'run_started'))
      stream?.emit(workspaceEvent(2, 'permission_requested'))
      stream?.emit(workspaceEvent(2, 'permission_requested'))
    })
    flushFrame()

    expect(result.current.diagnostic).toBeNull()
    expect(onBatch).toHaveBeenCalledOnce()
    expect((onBatch.mock.calls[0]?.[0] as WorkspaceEventBatch).events.map((event) => event.id))
      .toEqual([1, 2, 3])

    act(() => stream?.emit(workspaceEvent(2, 'run_completed')))
    flushFrame()
    expect(onBatch).toHaveBeenCalledOnce()
  })

  it('retains only the newest 2,048 ordered workspace events', () => {
    const { result } = renderHook(() => useWorkspaceEventStream({
      activeProjectId: 'project-1',
      api,
      cursor: 0,
      onBatch: vi.fn(),
    }))
    const stream = FakeEventSource.instances[0]

    act(() => {
      for (let id = 1; id <= 2_100; id += 1) stream?.emit(workspaceEvent(id, 'run_started'))
    })
    flushFrame()

    expect(result.current.events).toHaveLength(2_048)
    expect(result.current.events[0]?.id).toBe(53)
    expect(result.current.events.at(-1)?.id).toBe(2_100)
  })

  it('invalidates batch ownership on Project change without reopening EventSource', () => {
    const batches: WorkspaceEventBatch[] = []
    const { rerender } = renderHook(
      ({ projectId }) => useWorkspaceEventStream({
        activeProjectId: projectId,
        api,
        cursor: 0,
        onBatch: (batch) => batches.push(batch),
      }),
      { initialProps: { projectId: 'project-1' } },
    )
    const stream = FakeEventSource.instances[0]
    act(() => stream?.emit(workspaceEvent(1, 'session_updated')))
    flushFrame()
    expect(batches[0]?.ownership.isCurrent()).toBe(true)

    rerender({ projectId: 'project-2' })

    expect(batches[0]?.ownership.isCurrent()).toBe(false)
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(stream?.close).not.toHaveBeenCalled()
  })

  it('resets transport state and ownership when the stream identity changes', async () => {
    const batches: WorkspaceEventBatch[] = []
    const onReconcile = vi.fn().mockResolvedValue(undefined)
    const apiA = {
      workspaceEventStreamUrl: vi.fn((after: number) => `/events-a?after=${after}`),
    } as unknown as KubecodeApi
    const apiB = {
      workspaceEventStreamUrl: vi.fn((after: number) => `/events-b?after=${after}`),
    } as unknown as KubecodeApi
    const { result, rerender } = renderHook(
      ({ streamApi, cursor }) => useWorkspaceEventStream({
        activeProjectId: 'project-1',
        api: streamApi,
        cursor,
        onBatch: (batch) => batches.push(batch),
        onReconcile,
      }),
      { initialProps: { streamApi: apiA, cursor: 3 } },
    )
    const first = FakeEventSource.instances[0]
    act(() => first?.onopen?.(new Event('open')))
    act(() => first?.emit(workspaceEvent(4, 'session_updated')))
    flushFrame()
    expect(result.current.connectionState).toBe('live')
    expect(batches[0]?.ownership.isCurrent()).toBe(true)
    onReconcile.mockClear()

    rerender({ streamApi: apiB, cursor: 9 })

    const second = FakeEventSource.instances[1]
    expect(first?.close).toHaveBeenCalledOnce()
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(second?.url).toBe('/events-b?after=9')
    await waitFor(() => expect(result.current.connectionState).toBe('connecting'))
    expect(result.current.events).toEqual([])
    expect(batches[0]?.ownership.isCurrent()).toBe(false)

    act(() => second?.onopen?.(new Event('open')))
    expect(result.current.connectionState).toBe('live')
    expect(onReconcile).not.toHaveBeenCalled()
  })

  it('closes EventSource and prevents a cancelled frame from committing after unmount', () => {
    const onBatch = vi.fn()
    const { unmount } = renderHook(() => useWorkspaceEventStream({
      activeProjectId: 'project-1',
      api,
      cursor: 0,
      onBatch,
    }))
    const stream = FakeEventSource.instances[0]
    act(() => stream?.emit(workspaceEvent(1, 'run_started')))
    const lateFrame = [...frames.values()][0]

    unmount()
    act(() => lateFrame?.(16))

    expect(stream?.close).toHaveBeenCalledOnce()
    expect(cancelAnimationFrame).toHaveBeenCalledOnce()
    expect(onBatch).not.toHaveBeenCalled()
  })

  it('runs exactly one full reconciliation for a reconnect epoch', async () => {
    const recovery = deferred<void>()
    const onReconcile = vi.fn().mockReturnValue(recovery.promise)
    const { result } = renderHook(() => useWorkspaceEventStream({
      activeProjectId: 'project-1',
      api,
      cursor: 12,
      onBatch: vi.fn(),
      onReconcile,
    }))
    const stream = FakeEventSource.instances[0]
    expect(result.current.connectionState).toBe('connecting')
    expect(result.current.lastSuccessfulSyncAt).toBeNull()

    act(() => stream?.onopen?.(new Event('open')))
    expect(result.current.connectionState).toBe('live')
    expect(result.current.lastSuccessfulSyncAt).toBeNull()
    act(() => stream?.onerror?.(new Event('error')))
    expect(result.current.connectionState).toBe('reconnecting')
    act(() => {
      stream?.onopen?.(new Event('open'))
      stream?.onopen?.(new Event('open'))
    })

    expect(result.current.connectionState).toBe('resynchronizing')
    expect(onReconcile).toHaveBeenCalledOnce()
    const request = onReconcile.mock.calls[0]?.[0] as WorkspaceEventReconciliationRequest
    expect(request.ownership.projectId).toBe('project-1')
    expect(request.plan).toEqual({
      cleanTerminalIds: [],
      refreshGlobalSessions: true,
      refreshProjectRuns: true,
      refreshProjectSessions: true,
      refreshTeams: true,
      refreshTerminals: true,
    })
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(stream?.url).toBe('/events?after=12')

    await act(async () => recovery.resolve())
    expect(result.current.connectionState).toBe('live')
    expect(result.current.lastSuccessfulSyncAt).toEqual(expect.any(Number))
  })

  it('keeps failed reconciliation recoverable and retries without reopening the stream', async () => {
    const first = deferred<void>()
    const second = deferred<void>()
    const onReconcile = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const { result } = renderHook(() => useWorkspaceEventStream({
      activeProjectId: 'project-1',
      api,
      cursor: 7,
      onBatch: vi.fn(),
      onReconcile,
    }))
    const stream = FakeEventSource.instances[0]
    act(() => stream?.onopen?.(new Event('open')))
    act(() => stream?.onerror?.(new Event('error')))
    act(() => stream?.onopen?.(new Event('open')))

    await act(async () => first.reject(new Error('offline snapshot failed')))
    expect(result.current.connectionState).toBe('reconnecting')
    expect(result.current.lastSuccessfulSyncAt).toBeNull()

    act(() => result.current.retry())
    expect(result.current.connectionState).toBe('resynchronizing')
    expect(onReconcile).toHaveBeenCalledTimes(2)
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(stream?.url).toBe('/events?after=7')
    await act(async () => second.resolve())
    expect(result.current.connectionState).toBe('live')
    expect(result.current.lastSuccessfulSyncAt).toEqual(expect.any(Number))
  })

  it('supersedes recovery with one new-Project full plan and preserves queued commands', async () => {
    const first = deferred<void>()
    const second = deferred<void>()
    const commands = deferred<void>()
    const requests: WorkspaceEventReconciliationRequest[] = []
    const onReconcile = vi.fn((request: WorkspaceEventReconciliationRequest) => {
      requests.push(request)
      if (requests.length === 1) return first.promise
      return requests.length === 2 ? second.promise : commands.promise
    })
    const { result, rerender } = renderHook(
      ({ projectId }) => useWorkspaceEventStream({
        activeProjectId: projectId,
        api,
        cursor: 0,
        onBatch: vi.fn(),
        onReconcile,
      }),
      { initialProps: { projectId: 'project-1' } },
    )
    const stream = FakeEventSource.instances[0]
    act(() => stream?.onopen?.(new Event('open')))
    act(() => stream?.onerror?.(new Event('error')))
    act(() => stream?.onopen?.(new Event('open')))
    act(() => stream?.emit({
      ...workspaceEvent(1, 'terminal_exited'),
      payload: { terminal_id: 'terminal-1', exit_code: 0, signal: null },
    }))
    flushFrame()
    rerender({ projectId: 'project-2' })

    await waitFor(() => expect(onReconcile).toHaveBeenCalledTimes(2))
    expect(requests[0]?.ownership.isCurrent()).toBe(false)
    expect(requests[1]?.ownership.projectId).toBe('project-2')
    await act(async () => first.reject(new Error('stale Project failure')))
    expect(result.current.connectionState).toBe('resynchronizing')
    await act(async () => second.resolve())
    await waitFor(() => expect(onReconcile).toHaveBeenCalledTimes(3))
    expect(requests[2]?.ownership.projectId).toBe('project-2')
    expect(requests[2]?.plan.cleanTerminalIds).toEqual(['terminal-1'])
    await act(async () => commands.resolve())
    expect(result.current.connectionState).toBe('live')
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it('folds events during full recovery and drains one coalesced dirty-domain plan', async () => {
    const full = deferred<void>()
    const catchUp = deferred<void>()
    const requests: WorkspaceEventReconciliationRequest[] = []
    const onBatch = vi.fn()
    const onReconcile = vi.fn((request: WorkspaceEventReconciliationRequest) => {
      requests.push(request)
      return requests.length === 1 ? full.promise : catchUp.promise
    })
    const { result } = renderHook(() => useWorkspaceEventStream({
      activeProjectId: 'project-1',
      api,
      cursor: 0,
      onBatch,
      onReconcile,
    }))
    const stream = FakeEventSource.instances[0]
    act(() => stream?.onopen?.(new Event('open')))
    act(() => stream?.onerror?.(new Event('error')))
    act(() => stream?.onopen?.(new Event('open')))
    act(() => {
      stream?.emit(workspaceEvent(1, 'team_task_updated'))
      stream?.emit(workspaceEvent(2, 'session_updated'))
      stream?.emit(workspaceEvent(3, 'terminal_updated'))
      stream?.emit(workspaceEvent(4, 'run_started'))
    })
    flushFrame()

    expect(onBatch).toHaveBeenCalledOnce()
    expect(requests[0]?.eventsSinceStart().map((event) => event.id)).toEqual([1, 2, 3, 4])
    expect(requests[0]?.dirtyPlanSinceStart()).toEqual({
      cleanTerminalIds: [],
      refreshGlobalSessions: true,
      refreshProjectRuns: true,
      refreshProjectSessions: true,
      refreshTeams: true,
      refreshTerminals: true,
    })
    await act(async () => full.resolve())

    await waitFor(() => expect(onReconcile).toHaveBeenCalledTimes(2))
    expect(requests[1]?.plan).toEqual({
      cleanTerminalIds: [],
      refreshGlobalSessions: true,
      refreshProjectRuns: true,
      refreshProjectSessions: true,
      refreshTeams: true,
      refreshTerminals: true,
    })
    expect(result.current.connectionState).toBe('resynchronizing')
    await act(async () => catchUp.resolve())
    expect(result.current.connectionState).toBe('live')
  })
})

function workspaceEvent(id: number, kind: string): WorkspaceEvent {
  return {
    id,
    kind,
    project_id: 'project-1',
    conversation_id: 'session-1',
    run_id: 'run-1',
    payload: {},
    created_at: 'now',
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, reject, resolve }
}
