import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { GitStatus, KubecodeApi, WorkspaceEvent } from './api'
import { GIT_STATUS_DEBOUNCE_MS, useGitStatusController } from './useGitStatusController'

const initialStatus: GitStatus = {
  is_repository: true,
  branch: 'main',
  files: [{ path: 'a.txt', index_status: null, worktree_status: 'M', conflict: false }],
  truncated: false,
}

const cleanStatus: GitStatus = {
  is_repository: true,
  branch: 'main',
  files: [],
  truncated: false,
}

function gitChanged(id: number, payload: Record<string, unknown> = {}): WorkspaceEvent {
  return {
    id,
    kind: 'git_changed',
    project_id: 'project-1',
    conversation_id: null,
    run_id: null,
    payload,
    created_at: 'now',
  }
}

function fileChanged(id: number, path = 'src/a.ts'): WorkspaceEvent {
  return {
    id,
    kind: 'file_changed',
    project_id: 'project-1',
    conversation_id: null,
    run_id: null,
    payload: { path },
    created_at: 'now',
  }
}

afterEach(() => vi.useRealTimers())

describe('useGitStatusController', () => {
  it('loads Git status immediately for the active Project', async () => {
    const api = {
      gitStatus: vi.fn().mockResolvedValue(initialStatus),
    } as unknown as KubecodeApi

    const { result } = renderHook(() => useGitStatusController({
      api,
      onError: vi.fn(),
      projectId: 'project-1',
      workspaceEvents: [],
    }))

    await waitFor(() => expect(result.current.gitStatus).toEqual(initialStatus))
    expect(api.gitStatus).toHaveBeenCalledTimes(1)
    expect(api.gitStatus).toHaveBeenCalledWith('project-1', expect.any(AbortSignal))
  })

  it('debounces a filesystem burst into exactly one request', async () => {
    vi.useFakeTimers()
    const api = {
      gitStatus: vi.fn().mockResolvedValue(initialStatus),
    } as unknown as KubecodeApi
    const props = {
      api,
      onError: vi.fn(),
      projectId: 'project-1',
      workspaceEvents: [] as WorkspaceEvent[],
    }
    const { rerender } = renderHook(() => useGitStatusController(props))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(api.gitStatus).toHaveBeenCalledTimes(1)

    props.workspaceEvents = [fileChanged(1), fileChanged(2), fileChanged(3), gitChanged(4)]
    act(() => rerender())
    expect(api.gitStatus).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(GIT_STATUS_DEBOUNCE_MS) })
    expect(api.gitStatus).toHaveBeenCalledTimes(2)

    await act(async () => { await vi.advanceTimersByTimeAsync(GIT_STATUS_DEBOUNCE_MS) })
    expect(api.gitStatus).toHaveBeenCalledTimes(2)
  })

  it('keeps a single request in flight and issues exactly one follow-up', async () => {
    vi.useFakeTimers()
    const resolvers: Array<(status: GitStatus) => void> = []
    const api = {
      gitStatus: vi.fn().mockImplementation(() => new Promise<GitStatus>((resolve) => {
        resolvers.push(resolve)
      })),
    } as unknown as KubecodeApi
    const props = {
      api,
      onError: vi.fn(),
      projectId: 'project-1',
      workspaceEvents: [] as WorkspaceEvent[],
    }
    const { result, rerender } = renderHook(() => useGitStatusController(props))
    expect(api.gitStatus).toHaveBeenCalledTimes(1)

    props.workspaceEvents = [fileChanged(1)]
    act(() => rerender())
    await act(async () => { await vi.advanceTimersByTimeAsync(GIT_STATUS_DEBOUNCE_MS) })
    expect(api.gitStatus).toHaveBeenCalledTimes(1)

    props.workspaceEvents = [fileChanged(1), fileChanged(2), gitChanged(3)]
    act(() => rerender())
    await act(async () => { await vi.advanceTimersByTimeAsync(GIT_STATUS_DEBOUNCE_MS) })
    expect(api.gitStatus).toHaveBeenCalledTimes(1)

    act(() => { resolvers[0]?.(initialStatus) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(api.gitStatus).toHaveBeenCalledTimes(2)

    act(() => { resolvers[1]?.(cleanStatus) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.gitStatus).toEqual(cleanStatus)

    await act(async () => { await vi.advanceTimersByTimeAsync(GIT_STATUS_DEBOUNCE_MS) })
    expect(api.gitStatus).toHaveBeenCalledTimes(2)
  })

  it('discards stale responses after unmount without reporting errors', async () => {
    const resolvers: Array<(status: GitStatus) => void> = []
    const onError = vi.fn()
    const api = {
      gitStatus: vi.fn().mockImplementation(() => new Promise<GitStatus>((resolve) => {
        resolvers.push(resolve)
      })),
    } as unknown as KubecodeApi
    const { unmount } = renderHook(() => useGitStatusController({
      api,
      onError,
      projectId: 'project-1',
      workspaceEvents: [],
    }))
    expect(api.gitStatus).toHaveBeenCalledTimes(1)

    unmount()
    act(() => { resolvers[0]?.(initialStatus) })
    await act(async () => { await Promise.resolve() })

    expect(onError).not.toHaveBeenCalled()
  })

  it('discards stale responses after a Project switch', async () => {
    const resolvers: Array<(status: GitStatus) => void> = []
    const api = {
      gitStatus: vi.fn().mockImplementation(() => new Promise<GitStatus>((resolve) => {
        resolvers.push(resolve)
      })),
    } as unknown as KubecodeApi
    const props = {
      api,
      onError: vi.fn(),
      projectId: 'project-1' as string | null,
      workspaceEvents: [] as WorkspaceEvent[],
    }
    const { result, rerender } = renderHook(() => useGitStatusController(props))
    expect(api.gitStatus).toHaveBeenCalledTimes(1)

    props.projectId = 'project-2'
    act(() => rerender())
    expect(api.gitStatus).toHaveBeenCalledTimes(2)
    expect(api.gitStatus).toHaveBeenLastCalledWith('project-2', expect.any(AbortSignal))

    act(() => { resolvers[0]?.(initialStatus) })
    await act(async () => { await Promise.resolve() })
    expect(result.current.gitStatus).toBeNull()

    act(() => { resolvers[1]?.(cleanStatus) })
    await act(async () => { await Promise.resolve() })
    expect(result.current.gitStatus).toEqual(cleanStatus)
  })

  it('applies mutation responses immediately and coalesces their SSE echo', async () => {
    vi.useFakeTimers()
    const api = {
      gitStatus: vi.fn().mockResolvedValue(initialStatus),
    } as unknown as KubecodeApi
    const props = {
      api,
      onError: vi.fn(),
      projectId: 'project-1',
      workspaceEvents: [] as WorkspaceEvent[],
    }
    const { result, rerender } = renderHook(() => useGitStatusController(props))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(api.gitStatus).toHaveBeenCalledTimes(1)

    act(() => { result.current.beginMutation('stage') })
    act(() => { result.current.applyMutationResult(cleanStatus) })
    expect(result.current.gitStatus).toEqual(cleanStatus)

    props.workspaceEvents = [gitChanged(1, { action: 'stage' })]
    act(() => rerender())
    await act(async () => { await vi.advanceTimersByTimeAsync(GIT_STATUS_DEBOUNCE_MS) })
    expect(api.gitStatus).toHaveBeenCalledTimes(1)

    props.workspaceEvents = [
      gitChanged(1, { action: 'stage' }),
      gitChanged(2, { action: 'commit' }),
    ]
    act(() => rerender())
    await act(async () => { await vi.advanceTimersByTimeAsync(GIT_STATUS_DEBOUNCE_MS) })
    expect(api.gitStatus).toHaveBeenCalledTimes(2)
  })

  it('cancels a failed mutation so its action is not swallowed later', async () => {
    vi.useFakeTimers()
    const api = {
      gitStatus: vi.fn().mockResolvedValue(initialStatus),
    } as unknown as KubecodeApi
    const props = {
      api,
      onError: vi.fn(),
      projectId: 'project-1',
      workspaceEvents: [] as WorkspaceEvent[],
    }
    const { result, rerender } = renderHook(() => useGitStatusController(props))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(api.gitStatus).toHaveBeenCalledTimes(1)

    act(() => { result.current.beginMutation('stage') })
    act(() => { result.current.cancelMutation('stage') })

    props.workspaceEvents = [gitChanged(1, { action: 'stage' })]
    act(() => rerender())
    await act(async () => { await vi.advanceTimersByTimeAsync(GIT_STATUS_DEBOUNCE_MS) })
    expect(api.gitStatus).toHaveBeenCalledTimes(2)
  })

  it('makes manual refresh bypass the invalidation debounce', async () => {
    vi.useFakeTimers()
    const api = {
      gitStatus: vi.fn().mockResolvedValue(cleanStatus),
    } as unknown as KubecodeApi
    const props = {
      api,
      onError: vi.fn(),
      projectId: 'project-1',
      workspaceEvents: [] as WorkspaceEvent[],
    }
    const { result, rerender } = renderHook(() => useGitStatusController(props))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(api.gitStatus).toHaveBeenCalledTimes(1)

    props.workspaceEvents = [fileChanged(1)]
    act(() => rerender())
    expect(api.gitStatus).toHaveBeenCalledTimes(1)

    act(() => { result.current.refresh() })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(api.gitStatus).toHaveBeenCalledTimes(2)

    await act(async () => { await vi.advanceTimersByTimeAsync(GIT_STATUS_DEBOUNCE_MS) })
    expect(api.gitStatus).toHaveBeenCalledTimes(2)
  })

  it('ignores workspace events that arrived before the Project was active', async () => {
    const api = {
      gitStatus: vi.fn().mockResolvedValue(initialStatus),
    } as unknown as KubecodeApi

    renderHook(() => useGitStatusController({
      api,
      onError: vi.fn(),
      projectId: 'project-1',
      workspaceEvents: [fileChanged(1), gitChanged(2)],
    }))
    await act(async () => { await Promise.resolve() })
    expect(api.gitStatus).toHaveBeenCalledTimes(1)
  })
})
