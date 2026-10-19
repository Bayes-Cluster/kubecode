import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError, type KubecodeApi, type TaskDetail, type WorkspaceEvent } from '../api'
import { useRefreshTick } from '../research/useResearch'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'

export type TaskDetailStatus = 'loading' | 'ready' | 'draft' | 'error'

const KINDS = new Set(['task_updated', 'research_updated', 'work_updated', 'orchestration_updated'])

/**
 * One Task's inspector data, refetched on the events that can change it and
 * after a reconnect. A question that is not on the board (a proposal) is
 * `draft`, not an error: it has no card to inspect.
 */
export function useTaskDetail(
  api: KubecodeApi,
  projectId: string,
  taskId: string,
  events: WorkspaceEvent[],
  connectionState: WorkspaceConnectionState,
) {
  const key = `${projectId}/${taskId}`
  const [loaded, setLoaded] = useState<{ key: string; detail: TaskDetail | null } | null>(null)
  const [failedKey, setFailedKey] = useState<string | null>(null)
  const [manual, setManual] = useState(0)
  const matches = useCallback((event: WorkspaceEvent) => (
    KINDS.has(event.kind) && event.project_id === projectId
  ), [projectId])
  const tick = useRefreshTick(events, connectionState, matches)
  const ticket = useRef(0)

  useEffect(() => {
    if (typeof api.taskDetail !== 'function') return
    const mine = ++ticket.current
    api.taskDetail(projectId, taskId).then((detail) => {
      if (mine !== ticket.current) return
      setLoaded({ key, detail })
      setFailedKey(null)
    }).catch((cause) => {
      if (mine !== ticket.current) return
      if (cause instanceof ApiError && cause.code === 'task_not_found') {
        setLoaded({ key, detail: null })
        setFailedKey(null)
      } else {
        setFailedKey(key)
      }
    })
  }, [api, projectId, taskId, key, tick, manual])

  const current = loaded && loaded.key === key ? loaded : null
  const status: TaskDetailStatus = current
    ? (current.detail ? 'ready' : 'draft')
    : failedKey === key ? 'error' : 'loading'
  return {
    detail: current?.detail ?? null,
    status,
    reload: useCallback(() => setManual((value) => value + 1), []),
  }
}
