import { useCallback, useEffect, useRef, useState } from 'react'

import type { KubecodeApi, TaskBoard, TaskDraft, WorkspaceEvent } from '../api'
import { useRefreshTick } from '../research/useResearch'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'

export type TaskBoardStatus = 'loading' | 'ready' | 'error'

const KINDS = new Set(['task_updated', 'research_updated', 'work_updated', 'orchestration_updated'])

/**
 * The Workspace's one board (admitted Tasks) and its drafts (proposals that
 * are not on it), converged on the events that can change either and on stream
 * reconnects. A response older than the newest request never replaces it.
 */
export function useTaskBoard(
  api: KubecodeApi,
  projectId: string | null,
  events: WorkspaceEvent[],
  connectionState: WorkspaceConnectionState,
) {
  const [loaded, setLoaded] = useState<{
    projectId: string
    board: TaskBoard
    drafts: TaskDraft[]
  } | null>(null)
  const [failedProject, setFailedProject] = useState<string | null>(null)
  const [manual, setManual] = useState(0)
  const matches = useCallback((event: WorkspaceEvent) => (
    KINDS.has(event.kind) && event.project_id === projectId
  ), [projectId])
  const tick = useRefreshTick(events, connectionState, matches)
  const ticket = useRef(0)

  useEffect(() => {
    if (!projectId || typeof api.taskBoard !== 'function') return
    const mine = ++ticket.current
    Promise.all([api.taskBoard(projectId), api.taskDrafts(projectId)]).then(([board, drafts]) => {
      if (mine !== ticket.current) return
      setLoaded({ projectId, board, drafts })
      setFailedProject(null)
    }).catch(() => {
      if (mine === ticket.current) setFailedProject(projectId)
    })
  }, [api, projectId, tick, manual])

  const current = loaded && loaded.projectId === projectId ? loaded : null
  const status: TaskBoardStatus = current
    ? 'ready'
    : failedProject === projectId ? 'error' : 'loading'
  return {
    board: current?.board ?? null,
    drafts: current?.drafts ?? [],
    status,
    reload: useCallback(() => setManual((value) => value + 1), []),
  }
}
