import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { KubecodeApi, WorkspaceEvent } from './api'
import { useWorkspaceEventStream, type WorkspaceEventBatch } from './useWorkspaceEventStream'

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
