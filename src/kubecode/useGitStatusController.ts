import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { GitStatus, KubecodeApi, WorkspaceEvent } from './api'

export const GIT_STATUS_DEBOUNCE_MS = 250

export type GitStatusControllerOptions = {
  api: KubecodeApi
  /** Debounce window for filesystem invalidations. Manual refresh bypasses it. */
  debounceMs?: number
  onError: (cause: unknown) => void
  projectId: string | null
  workspaceEvents: WorkspaceEvent[]
}

export type GitStatusController = {
  gitStatus: GitStatus | null
  /** Manual refresh; bypasses the invalidation debounce. */
  refresh: () => void
  /** Register an in-flight Git mutation so its SSE echo is coalesced. */
  beginMutation: (action: string) => void
  /** Apply a mutation response immediately. */
  applyMutationResult: (status: GitStatus) => void
  /** Undo echo registration when a mutation fails before its echo arrives. */
  cancelMutation: (action: string) => void
}

/**
 * Schedules Git status reads for one Project. Filesystem invalidations are
 * debounced, at most one request is active per Project, and a burst while a
 * request is running produces exactly one follow-up. Every response is fenced
 * by a Project-scoped generation so stale results cannot commit after a Project
 * switch or unmount. Mutation responses apply immediately and coalesce their
 * echoed `git_changed` SSE invalidation instead of launching a duplicate.
 */
export function useGitStatusController({
  api,
  debounceMs = GIT_STATUS_DEBOUNCE_MS,
  onError,
  projectId,
  workspaceEvents,
}: GitStatusControllerOptions): GitStatusController {
  const [gitStatusEntry, setGitStatusEntry] = useState<{
    projectId: string
    status: GitStatus
  } | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const debounceTimerRef = useRef<number | null>(null)
  const followUpPendingRef = useRef(false)
  const inflightEpochRef = useRef<number | null>(null)
  const mountedRef = useRef(false)
  const onErrorRef = useRef(onError)
  const pendingMutationEchoesRef = useRef(new Map<string, number>())
  const processedEventIdRef = useRef(workspaceEvents.at(-1)?.id ?? 0)
  const projectIdRef = useRef(projectId)
  const sessionEpochRef = useRef(0)
  const workspaceEventsRef = useRef(workspaceEvents)

  useLayoutEffect(() => {
    onErrorRef.current = onError
  }, [onError])

  const clearDebounce = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
  }, [])

  const scheduleRequestRef = useRef<(targetProjectId: string) => void>(() => undefined)

  const scheduleRequest = useCallback((targetProjectId: string) => {
    if (inflightEpochRef.current === sessionEpochRef.current) {
      followUpPendingRef.current = true
      return
    }
    const epoch = sessionEpochRef.current
    const controller = new AbortController()
    abortControllerRef.current = controller
    inflightEpochRef.current = epoch
    void api.gitStatus(targetProjectId, controller.signal).then(
      (status) => {
        if (epoch !== sessionEpochRef.current
          || !mountedRef.current
          || abortControllerRef.current !== controller) return
        setGitStatusEntry({ projectId: targetProjectId, status })
      },
      (cause: unknown) => {
        if (epoch !== sessionEpochRef.current
          || !mountedRef.current
          || abortControllerRef.current !== controller) return
        if (isAbortError(cause)) return
        onErrorRef.current(cause)
      },
    ).finally(() => {
      if (epoch !== sessionEpochRef.current) return
      inflightEpochRef.current = null
      abortControllerRef.current = null
      if (followUpPendingRef.current) {
        followUpPendingRef.current = false
        scheduleRequestRef.current(targetProjectId)
      }
    })
  }, [api])

  useLayoutEffect(() => {
    scheduleRequestRef.current = scheduleRequest
  }, [scheduleRequest])

  const scheduleDebounced = useCallback((targetProjectId: string) => {
    clearDebounce()
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null
      scheduleRequest(targetProjectId)
    }, debounceMs)
  }, [clearDebounce, debounceMs, scheduleRequest])

  const consumePendingMutationEcho = useCallback((action: string): boolean => {
    const current = pendingMutationEchoesRef.current.get(action) ?? 0
    if (current <= 0) return false
    pendingMutationEchoesRef.current.set(action, current - 1)
    return true
  }, [])

  const refresh = useCallback(() => {
    clearDebounce()
    const targetProjectId = projectIdRef.current
    if (targetProjectId) scheduleRequest(targetProjectId)
  }, [clearDebounce, scheduleRequest])

  const beginMutation = useCallback((action: string) => {
    sessionEpochRef.current += 1
    followUpPendingRef.current = false
    clearDebounce()
    abortControllerRef.current?.abort()
    pendingMutationEchoesRef.current.set(
      action,
      (pendingMutationEchoesRef.current.get(action) ?? 0) + 1,
    )
  }, [clearDebounce])

  const applyMutationResult = useCallback((status: GitStatus) => {
    sessionEpochRef.current += 1
    const targetProjectId = projectIdRef.current
    if (targetProjectId) setGitStatusEntry({ projectId: targetProjectId, status })
  }, [])

  const cancelMutation = useCallback((action: string) => {
    const current = pendingMutationEchoesRef.current.get(action) ?? 0
    if (current > 0) pendingMutationEchoesRef.current.set(action, current - 1)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    const targetProjectId = projectId
    projectIdRef.current = targetProjectId
    sessionEpochRef.current += 1
    followUpPendingRef.current = false
    clearDebounce()
    abortControllerRef.current?.abort()
    if (targetProjectId) {
      pendingMutationEchoesRef.current = new Map()
      processedEventIdRef.current = Math.max(
        processedEventIdRef.current,
        workspaceEventsRef.current.at(-1)?.id ?? 0,
      )
      scheduleRequest(targetProjectId)
    }
    return () => {
      sessionEpochRef.current += 1
      clearDebounce()
      abortControllerRef.current?.abort()
    }
  }, [clearDebounce, projectId, scheduleRequest])

  useEffect(() => {
    workspaceEventsRef.current = workspaceEvents
    const targetProjectId = projectId
    projectIdRef.current = targetProjectId
    if (!targetProjectId) return
    const nextEvents = workspaceEvents.filter(
      (event) => event.id > processedEventIdRef.current
        && event.project_id === targetProjectId,
    )
    processedEventIdRef.current = workspaceEvents.at(-1)?.id
      ?? processedEventIdRef.current
    for (const event of nextEvents) {
      if (event.kind === 'git_changed') {
        const action = typeof event.payload.action === 'string'
          ? event.payload.action
          : null
        if (action && consumePendingMutationEcho(action)) continue
        scheduleDebounced(targetProjectId)
      } else if (event.kind === 'file_changed') {
        scheduleDebounced(targetProjectId)
      }
    }
  }, [consumePendingMutationEcho, projectId, scheduleDebounced, workspaceEvents])

  return {
    gitStatus: gitStatusEntry && gitStatusEntry.projectId === projectId
      ? gitStatusEntry.status
      : null,
    refresh,
    beginMutation,
    applyMutationResult,
    cancelMutation,
  }
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'AbortError'
}
