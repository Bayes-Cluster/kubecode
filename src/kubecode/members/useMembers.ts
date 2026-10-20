import { useCallback, useEffect, useRef, useState } from 'react'

import type { KubecodeApi, MemberRoster, WorkspaceEvent } from '../api'
import { useRefreshTick } from '../research/useResearch'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'

export type MemberLoadStatus = 'loading' | 'ready' | 'error'

/**
 * The Workspace roster, refetched on member events and after a reconnect, and
 * never replaced by a response older than the newest request. With
 * `includeRemoved` it also has the members that were removed, so a
 * conversation keeps naming them (ADR 0229 §1).
 */
export function useMembers(
  api: KubecodeApi,
  projectId: string | null,
  events: WorkspaceEvent[],
  connectionState: WorkspaceConnectionState,
  { includeRemoved = false }: { includeRemoved?: boolean } = {},
) {
  const [loaded, setLoaded] = useState<{ projectId: string; roster: MemberRoster } | null>(null)
  const [failedProject, setFailedProject] = useState<string | null>(null)
  const [manual, setManual] = useState(0)
  const matches = useCallback(
    (event: WorkspaceEvent) => event.kind === 'member_updated' && event.project_id === projectId,
    [projectId],
  )
  const tick = useRefreshTick(events, connectionState, matches)
  const ticket = useRef(0)

  useEffect(() => {
    if (!projectId || typeof api.listMembers !== 'function') return
    const mine = ++ticket.current
    api.listMembers(projectId, includeRemoved).then((roster) => {
      if (mine !== ticket.current) return
      setLoaded({ projectId, roster })
      setFailedProject(null)
    }).catch(() => {
      if (mine === ticket.current) setFailedProject(projectId)
    })
  }, [api, includeRemoved, projectId, tick, manual])

  const current = loaded && loaded.projectId === projectId ? loaded.roster : null
  const status: MemberLoadStatus = current
    ? 'ready'
    : failedProject === projectId ? 'error' : 'loading'
  return {
    roster: current,
    status,
    refreshFailed: Boolean(current) && failedProject === projectId,
    reload: useCallback(() => setManual((value) => value + 1), []),
  }
}
