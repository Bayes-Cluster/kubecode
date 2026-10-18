import { useCallback, useEffect, useRef, useState } from 'react'

import type { KubecodeApi, WorkBoard, WorkBoardFilter, WorkDetail, WorkspaceEvent } from '../api'
import { useRefreshTick } from '../research/useResearch'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'

export type WorkLoadStatus = 'loading' | 'ready' | 'error'

function matchesWork(event: WorkspaceEvent, projectId: string | null): boolean {
  return (event.kind === 'work_updated' || event.kind === 'orchestration_updated')
    && event.project_id === projectId
}

/**
 * The one board under a filter. It refetches the authoritative projection on
 * work and routing events, on a return to a live stream, and when `refreshKey`
 * changes (a host that has its own source of change, such as a Team snapshot),
 * and drops any response older than the newest request.
 */
export function useWorkBoard(
  api: KubecodeApi,
  projectId: string | null,
  filter: WorkBoardFilter,
  events: WorkspaceEvent[],
  connectionState: WorkspaceConnectionState,
  refreshKey = '',
) {
  const filterKey = JSON.stringify(filter)
  const scope = projectId ? `${projectId}|${filterKey}` : null
  const [loaded, setLoaded] = useState<{ scope: string; board: WorkBoard } | null>(null)
  const [failedScope, setFailedScope] = useState<string | null>(null)
  const [manual, setManual] = useState(0)
  const matches = useCallback((event: WorkspaceEvent) => matchesWork(event, projectId), [projectId])
  const tick = useRefreshTick(events, connectionState, matches)
  const ticket = useRef(0)

  useEffect(() => {
    if (!scope || !projectId || typeof api.workBoard !== 'function') return
    const mine = ++ticket.current
    api.workBoard(projectId, JSON.parse(filterKey) as WorkBoardFilter).then((board) => {
      if (mine !== ticket.current) return
      setLoaded({ scope, board })
      setFailedScope(null)
    }).catch(() => {
      if (mine === ticket.current) setFailedScope(scope)
    })
  }, [api, projectId, scope, filterKey, tick, manual, refreshKey])

  const current = loaded && loaded.scope === scope ? loaded.board : null
  const unsupported = typeof api.workBoard !== 'function'
  const status: WorkLoadStatus = current || unsupported
    ? 'ready'
    : failedScope === scope ? 'error' : 'loading'
  return {
    board: current,
    status,
    reload: useCallback(() => setManual((value) => value + 1), []),
  }
}

/** One card's inspector record, refetched with the board. */
export function useWorkDetail(
  api: KubecodeApi,
  projectId: string | null,
  workId: string | null,
  events: WorkspaceEvent[],
  connectionState: WorkspaceConnectionState,
  refreshKey = '',
) {
  const scope = projectId && workId ? `${projectId}|${workId}` : null
  const [loaded, setLoaded] = useState<{ scope: string; detail: WorkDetail } | null>(null)
  const [failedScope, setFailedScope] = useState<string | null>(null)
  const [manual, setManual] = useState(0)
  const matches = useCallback((event: WorkspaceEvent) => matchesWork(event, projectId), [projectId])
  const tick = useRefreshTick(events, connectionState, matches)
  const ticket = useRef(0)

  useEffect(() => {
    if (!scope || !projectId || !workId || typeof api.workDetail !== 'function') return
    const mine = ++ticket.current
    api.workDetail(projectId, workId).then((detail) => {
      if (mine !== ticket.current) return
      setLoaded({ scope, detail })
      setFailedScope(null)
    }).catch(() => {
      if (mine === ticket.current) setFailedScope(scope)
    })
  }, [api, projectId, workId, scope, tick, manual, refreshKey])

  const current = loaded && loaded.scope === scope ? loaded.detail : null
  const status: WorkLoadStatus = current ? 'ready' : failedScope === scope ? 'error' : 'loading'
  return {
    detail: current,
    status,
    reload: useCallback(() => setManual((value) => value + 1), []),
  }
}
