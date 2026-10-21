import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { AttentionSnapshot, KubecodeApi, WorkspaceEvent } from '../api'
import { useRefreshTick } from '../research/useResearch'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'
import type { AttentionStore, ExecutionScope } from './attentionContext'

/** The changes that can add or remove what waits on the researcher. */
const KINDS = new Set([
  'task_updated',
  'research_updated',
  'work_updated',
  'member_updated',
  'channel_updated',
  'orchestration_updated',
  'permission_requested',
  'permission_resolved',
  'permission_reviewed',
  'elicitation_requested',
  'elicitation_resolved',
  'team_permission_updated',
  'session_updated',
  'run_started',
  'run_completed',
  'prompt_queue',
])
const DEBOUNCE_MS = 250
const RESOLVING_FALLBACK_MS = 10_000

function inScope(scope: ExecutionScope, entry: { binding: string | null; member: { id: string } | null; tasks?: { id: string }[] }) {
  if ('taskId' in scope) return entry.tasks?.some((task) => task.id === scope.taskId) ?? false
  if (scope.binding === 'public') return entry.binding === 'public'
  return entry.binding === 'dm' && entry.member?.id === scope.memberId
}

/**
 * One Workspace's attention snapshot (ADR 0232), refetched — debounced — on
 * the changes that can alter it and after a reconnect. A response older than
 * the one shown, by request or by event cursor, is dropped.
 */
export function useAttentionStore(
  api: KubecodeApi,
  projectId: string | null,
  events: WorkspaceEvent[],
  connectionState: WorkspaceConnectionState,
): AttentionStore {
  const [loaded, setLoaded] = useState<{ projectId: string; snapshot: AttentionSnapshot } | null>(null)
  const [failedFor, setFailedFor] = useState<string | null>(null)
  const [manual, setManual] = useState(0)
  // Answered keys: `null` while the answer is in flight, then the request ticket it was recorded at.
  const [resolvingKeys, setResolvingKeys] = useState<ReadonlyMap<string, number | null>>(new Map())
  const matches = useCallback((event: WorkspaceEvent) => (
    event.project_id === projectId
      && (KINDS.has(event.kind) || (event.kind === 'conversation_state' && Object.hasOwn(event.payload, 'pending')))
  ), [projectId])
  const tick = useRefreshTick(events, connectionState, matches)
  const ticket = useRef(0)
  const applied = useRef<{ projectId: string | null; ticket: number; cursor: number }>({ projectId: null, ticket: 0, cursor: -1 })
  const requestedFor = useRef<string | null>(null)
  const timers = useRef(new Set<number>())
  useEffect(() => {
    const pending = timers.current
    return () => pending.forEach((timer) => window.clearTimeout(timer))
  }, [])

  useEffect(() => {
    if (!projectId || typeof api.attention !== 'function') return
    const read = () => {
      const mine = ++ticket.current
      api.attention(projectId).then((snapshot) => {
        const last = applied.current
        const same = last.projectId === projectId
        if (same && (mine < last.ticket || snapshot.cursor < last.cursor)) return
        applied.current = { projectId, ticket: mine, cursor: snapshot.cursor }
        setLoaded({ projectId, snapshot })
        setFailedFor(null)
        const listed = new Set(snapshot.items.map((item) => item.key))
        setResolvingKeys((current) => {
          const gone = [...current].filter(([key, after]) => after !== null && mine > after && !listed.has(key))
          if (gone.length === 0) return current
          const next = new Map(current)
          gone.forEach(([key]) => next.delete(key))
          return next
        })
      }).catch(() => {
        const last = applied.current
        if (last.projectId === projectId && mine < last.ticket) return
        setFailedFor(projectId)
      })
    }
    // The first read of a Workspace is at once; changes after it are gathered.
    if (requestedFor.current !== projectId) {
      requestedFor.current = projectId
      read()
      return
    }
    const timer = window.setTimeout(read, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [api, projectId, tick, manual])

  const reload = useCallback(() => setManual((value) => value + 1), [])

  const markResolving = useCallback(async <T,>(key: string, call: () => Promise<T>): Promise<T> => {
    setResolvingKeys((current) => new Map(current).set(key, null))
    try {
      const result = await call()
      setResolvingKeys((current) => new Map(current).set(key, ticket.current))
      reload()
      const timer = window.setTimeout(() => {
        timers.current.delete(timer)
        setResolvingKeys((current) => {
          if (!current.has(key)) return current
          const next = new Map(current)
          next.delete(key)
          return next
        })
        reload()
      }, RESOLVING_FALLBACK_MS)
      timers.current.add(timer)
      return result
    } catch (cause) {
      setResolvingKeys((current) => {
        const next = new Map(current)
        next.delete(key)
        return next
      })
      throw cause
    }
  }, [reload])

  const snapshot = loaded && loaded.projectId === projectId ? loaded.snapshot : null
  const status = failedFor === projectId && projectId ? 'error' : snapshot ? 'ready' : 'loading'
  const resolving = useMemo(() => new Set(resolvingKeys.keys()), [resolvingKeys])
  return useMemo<AttentionStore>(() => ({
    projectId,
    snapshot,
    status,
    forTask: (taskId) => snapshot?.items.filter((item) => item.task?.id === taskId) ?? [],
    byKey: (key) => snapshot?.items.find((item) => item.key === key),
    executions: (scope) => snapshot?.executions.filter((run) => inScope(scope, run)) ?? [],
    failures: (scope) => snapshot?.failures.filter((run) => inScope(scope, run)) ?? [],
    resolving,
    markResolving,
    reload,
  }), [markResolving, projectId, reload, resolving, snapshot, status])
}
