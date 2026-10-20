import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AttentionSnapshot, KubecodeApi, WorkspaceEvent } from '../api'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'
import { execution, permissionItem, pruning, questionItem, snapshot } from './attentionFixtures'
import { useAttentionStore } from './useAttention'

const event = (id: number, kind: string, payload: Record<string, unknown> = {}, project = 'p1'): WorkspaceEvent => ({
  id, kind, project_id: project, conversation_id: null, run_id: null, payload, created_at: '',
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function setup(answers: Array<AttentionSnapshot | Promise<AttentionSnapshot> | Error>) {
  const attention = vi.fn(() => {
    const next = answers.length > 1 ? answers.shift() : answers[0]
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next as AttentionSnapshot)
  })
  const api = { attention } as unknown as KubecodeApi
  const view = renderHook(
    ({ events, connection }: { events: WorkspaceEvent[]; connection: WorkspaceConnectionState }) => (
      useAttentionStore(api, 'p1', events, connection)
    ),
    { initialProps: { events: [] as WorkspaceEvent[], connection: 'live' as WorkspaceConnectionState } },
  )
  return { attention, view }
}

describe('useAttentionStore (ADR 0232)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reads the projection on mount and answers per Task, per key and per scope', async () => {
    const { attention, view } = setup([snapshot({
      items: [permissionItem(), questionItem()],
      executions: [execution(), execution({ run_id: 'run2', conversation_id: 'dm1', binding: 'dm', tasks: [] })],
    })])
    expect(view.result.current.status).toBe('loading')
    await flush()
    expect(attention).toHaveBeenCalledWith('p1')
    const store = view.result.current
    expect(store.status).toBe('ready')
    expect(store.forTask(pruning.id).map((item) => item.key)).toEqual(['permission:q1', 'question:d1'])
    expect(store.byKey('question:d1')?.kind).toBe('question')
    expect(store.executions({ binding: 'public' }).map((run) => run.run_id)).toEqual(['run1'])
    expect(store.executions({ binding: 'dm', memberId: 'm1' }).map((run) => run.run_id)).toEqual(['run2'])
    expect(store.executions({ taskId: pruning.id }).map((run) => run.run_id)).toEqual(['run1'])
  })

  it('refetches once for a burst of changes, only for this Workspace, and after a reconnect', async () => {
    const { attention, view } = setup([snapshot()])
    await flush()
    expect(attention).toHaveBeenCalledTimes(1)
    view.rerender({ events: [event(1, 'task_updated'), event(2, 'work_updated'), event(3, 'task_updated', {}, 'p2')], connection: 'live' })
    view.rerender({ events: [event(1, 'task_updated'), event(2, 'work_updated'), event(4, 'permission_requested')], connection: 'live' })
    await act(async () => { vi.advanceTimersByTime(300) })
    await flush()
    expect(attention).toHaveBeenCalledTimes(2)
    // Chatty Session state counts only when it says whether something is pending.
    view.rerender({ events: [event(5, 'conversation_state', { status: 'running' })], connection: 'live' })
    await act(async () => { vi.advanceTimersByTime(300) })
    expect(attention).toHaveBeenCalledTimes(2)
    view.rerender({ events: [event(6, 'conversation_state', { pending: null })], connection: 'live' })
    await act(async () => { vi.advanceTimersByTime(300) })
    await flush()
    expect(attention).toHaveBeenCalledTimes(3)
    view.rerender({ events: [event(6, 'conversation_state', { pending: null })], connection: 'reconnecting' })
    view.rerender({ events: [event(6, 'conversation_state', { pending: null })], connection: 'live' })
    await act(async () => { vi.advanceTimersByTime(300) })
    await flush()
    expect(attention).toHaveBeenCalledTimes(4)
  })

  it('never applies an older answer over a newer one', async () => {
    const slow = deferred<AttentionSnapshot>()
    const fast = deferred<AttentionSnapshot>()
    const { view } = setup([snapshot({ cursor: 5 }), slow.promise, fast.promise])
    await flush()
    act(() => view.result.current.reload())
    await act(async () => { vi.advanceTimersByTime(300) })
    act(() => view.result.current.reload())
    await act(async () => { vi.advanceTimersByTime(300) })
    fast.resolve(snapshot({ cursor: 9, items: [questionItem()] }))
    await flush()
    slow.resolve(snapshot({ cursor: 7 }))
    await flush()
    expect(view.result.current.snapshot?.cursor).toBe(9)
    expect(view.result.current.snapshot?.items).toHaveLength(1)
  })

  it('drops a snapshot whose cursor is older than the one shown', async () => {
    const { view } = setup([snapshot({ cursor: 9, items: [questionItem()] }), snapshot({ cursor: 3 })])
    await flush()
    act(() => view.result.current.reload())
    await act(async () => { vi.advanceTimersByTime(300) })
    await flush()
    expect(view.result.current.snapshot?.cursor).toBe(9)
  })

  it('keeps an answered decision resolving until a newer snapshot omits it', async () => {
    const { view } = setup([snapshot({ items: [questionItem()] }), snapshot({ cursor: 2 })])
    await flush()
    let settle!: () => void
    let call!: Promise<void>
    act(() => {
      call = view.result.current.markResolving('question:d1', () => new Promise<void>((done) => { settle = done }))
    })
    expect(view.result.current.resolving.has('question:d1')).toBe(true)
    await act(async () => {
      settle()
      await call
    })
    // The row stays, busy, until the server's next snapshot drops it.
    expect(view.result.current.snapshot?.items).toHaveLength(1)
    expect(view.result.current.resolving.has('question:d1')).toBe(true)
    await act(async () => { vi.advanceTimersByTime(300) })
    await flush()
    expect(view.result.current.snapshot?.items).toHaveLength(0)
    expect(view.result.current.resolving.has('question:d1')).toBe(false)
  })

  it('gives the key back and rethrows when the answer is refused', async () => {
    const { view } = setup([snapshot({ items: [questionItem()] })])
    await flush()
    let outcome: unknown
    await act(async () => {
      outcome = await view.result.current.markResolving('question:d1', () => Promise.reject(new Error('no'))).catch((cause) => cause)
    })
    expect(outcome).toBeInstanceOf(Error)
    expect(view.result.current.resolving.has('question:d1')).toBe(false)
  })

  it('stops showing a decision as resolving after ten seconds even if it is still listed', async () => {
    const { view } = setup([snapshot({ items: [questionItem()] })])
    await flush()
    await act(async () => {
      await view.result.current.markResolving('question:d1', () => Promise.resolve())
    })
    await act(async () => { vi.advanceTimersByTime(300) })
    await flush()
    expect(view.result.current.resolving.has('question:d1')).toBe(true)
    await act(async () => { vi.advanceTimersByTime(10_000) })
    await flush()
    expect(view.result.current.resolving.has('question:d1')).toBe(false)
  })

  it('keeps the last snapshot when a read fails, and says so', async () => {
    const { view } = setup([snapshot({ items: [questionItem()] }), new Error('down')])
    await flush()
    act(() => view.result.current.reload())
    await act(async () => { vi.advanceTimersByTime(300) })
    await flush()
    expect(view.result.current.status).toBe('error')
    expect(view.result.current.snapshot?.items).toHaveLength(1)
  })
})
