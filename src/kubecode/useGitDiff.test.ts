import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useGitDiff } from './useGitDiff'
import type { GitDiffResult, KubecodeApi } from './api'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

afterEach(() => vi.restoreAllMocks())

describe('useGitDiff', () => {
  it('fences every response by path, staged target, and request generation', async () => {
    const first = deferred<GitDiffResult>()
    const second = deferred<GitDiffResult>()
    const signals: AbortSignal[] = []
    const gitDiff = vi.fn().mockImplementation(
      (_projectId: string, _path: string, _staged: boolean, signal?: AbortSignal) => {
        signals.push(signal as AbortSignal)
        return signals.length === 1 ? first.promise : second.promise
      },
    )
    const { result } = renderHook(() => useGitDiff({ gitDiff } as unknown as KubecodeApi))

    act(() => result.current.open({ projectId: 'p', path: 'a.txt', staged: false }))
    expect(result.current.state).toMatchObject({ kind: 'loading' })
    act(() => result.current.open({ projectId: 'p', path: 'b.txt', staged: true }))
    expect(signals[0].aborted).toBe(true)

    await act(async () => { first.resolve({ diff: 'a diff', unavailable_reason: null }) })
    expect(result.current.state).toMatchObject({
      kind: 'loading',
      target: { path: 'b.txt', staged: true },
    })

    await act(async () => { second.resolve({ diff: 'b diff', unavailable_reason: null }) })
    expect(result.current.state).toMatchObject({
      kind: 'ready',
      target: { path: 'b.txt', staged: true },
      content: 'b diff',
    })
  })

  it('drops a failure that belongs to a superseded request', async () => {
    const stale = deferred<GitDiffResult>()
    const current = deferred<GitDiffResult>()
    const gitDiff = vi.fn().mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => current.promise)
    const { result } = renderHook(() => useGitDiff({ gitDiff } as unknown as KubecodeApi))

    act(() => result.current.open({ projectId: 'p', path: 'a.txt', staged: false }))
    act(() => result.current.open({ projectId: 'p', path: 'b.txt', staged: false }))
    await act(async () => { stale.reject(new Error('stale failure')) })
    expect(result.current.state).toMatchObject({ kind: 'loading', target: { path: 'b.txt' } })

    await act(async () => { current.resolve({ diff: 'b diff', unavailable_reason: null }) })
    expect(result.current.state).toMatchObject({ kind: 'ready', content: 'b diff' })
  })

  it('captures the latest failure and reports a recoverable state', async () => {
    const gitDiff = vi.fn().mockRejectedValue(new Error('git exploded'))
    const { result } = renderHook(() => useGitDiff({ gitDiff } as unknown as KubecodeApi))

    act(() => result.current.open({ projectId: 'p', path: 'a.txt', staged: false }))
    await act(async () => { await Promise.resolve() })
    expect(result.current.state).toMatchObject({
      kind: 'failed',
      target: { path: 'a.txt' },
    })
  })

  it('aborts the in-flight request when closed or unmounted', async () => {
    const pending = deferred<GitDiffResult>()
    const signals: AbortSignal[] = []
    const gitDiff = vi.fn().mockImplementation(
      (_projectId: string, _path: string, _staged: boolean, signal?: AbortSignal) => {
        signals.push(signal as AbortSignal)
        return pending.promise
      },
    )
    const { result, unmount } = renderHook(() => useGitDiff({ gitDiff } as unknown as KubecodeApi))

    act(() => result.current.open({ projectId: 'p', path: 'a.txt', staged: false }))
    expect(signals[0].aborted).toBe(false)
    act(() => result.current.close())
    expect(signals[0].aborted).toBe(true)
    expect(result.current.state).toMatchObject({ kind: 'idle' })

    act(() => result.current.open({ projectId: 'p', path: 'b.txt', staged: false }))
    expect(signals[1].aborted).toBe(false)
    unmount()
    expect(signals[1].aborted).toBe(true)
  })
})
