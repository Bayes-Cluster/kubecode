import { useCallback, useEffect, useRef, useState } from 'react'

import type { DmTurn, KubecodeApi, WorkspaceEvent } from '../api'
import { useRefreshTick } from '../research/useResearch'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'

export type DmLoadStatus = 'loading' | 'ready' | 'error'

/**
 * The turns of the researcher's private conversation with one member. They are
 * read from the member's DM Session and converge on that Session's events and
 * on stream reconnects; they are never mixed into the shared conversation.
 */
export function useDmTurns(
  api: KubecodeApi,
  projectId: string,
  memberId: string,
  dmConversationId: string | null,
  events: WorkspaceEvent[],
  connectionState: WorkspaceConnectionState,
) {
  const key = `${projectId}/${memberId}`
  const [loaded, setLoaded] = useState<{ key: string; turns: DmTurn[] } | null>(null)
  const [failedKey, setFailedKey] = useState<string | null>(null)
  const [manual, setManual] = useState(0)
  const matches = useCallback(
    (event: WorkspaceEvent) => dmConversationId !== null && event.conversation_id === dmConversationId,
    [dmConversationId],
  )
  const tick = useRefreshTick(events, connectionState, matches)
  const ticket = useRef(0)

  useEffect(() => {
    if (!dmConversationId || typeof api.memberDmTurns !== 'function') return
    const mine = ++ticket.current
    api.memberDmTurns(projectId, memberId).then((turns) => {
      if (mine !== ticket.current) return
      setLoaded({ key, turns })
      setFailedKey(null)
    }).catch(() => {
      if (mine === ticket.current) setFailedKey(key)
    })
  }, [api, projectId, memberId, dmConversationId, key, tick, manual])

  const current = loaded && loaded.key === key ? loaded.turns : null
  const status: DmLoadStatus = current ? 'ready' : failedKey === key ? 'error' : 'loading'
  return {
    turns: current ?? [],
    status,
    reload: useCallback(() => setManual((value) => value + 1), []),
  }
}
