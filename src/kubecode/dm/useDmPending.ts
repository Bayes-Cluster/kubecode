import { useCallback, useEffect, useRef, useState } from 'react'

import type { DmPendingPrompt, KubecodeApi, WorkspaceEvent } from '../api'
import { useRefreshTick } from '../research/useResearch'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'

/**
 * Direct messages queued behind the member's running reply (ADR 0232), read
 * from the server so they stay visible after a reload, and refreshed on the
 * DM Session's events until the member starts on them.
 */
export function useDmPending(
  api: KubecodeApi,
  projectId: string,
  memberId: string,
  dmConversationId: string | null,
  events: WorkspaceEvent[],
  connectionState: WorkspaceConnectionState,
) {
  const key = `${projectId}/${memberId}`
  const [loaded, setLoaded] = useState<{ key: string; pending: DmPendingPrompt[] } | null>(null)
  const [manual, setManual] = useState(0)
  const matches = useCallback(
    (event: WorkspaceEvent) => dmConversationId !== null && event.conversation_id === dmConversationId,
    [dmConversationId],
  )
  const tick = useRefreshTick(events, connectionState, matches)
  const ticket = useRef(0)
  useEffect(() => {
    if (!dmConversationId || typeof api.memberDmPending !== 'function') return
    const mine = ++ticket.current
    api.memberDmPending(projectId, memberId).then((pending) => {
      if (mine === ticket.current) setLoaded({ key, pending })
    }).catch(() => undefined)
  }, [api, projectId, memberId, dmConversationId, key, tick, manual])
  return {
    pending: loaded && loaded.key === key ? loaded.pending : [],
    reload: useCallback(() => setManual((value) => value + 1), []),
  }
}
