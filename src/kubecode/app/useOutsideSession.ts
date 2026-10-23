import { useEffect, useState } from 'react'

import type { Conversation, KubecodeApi } from '../api'

type Lookup = { key: string; session: Conversation | null }

/**
 * A Session the place names that the Sessions list leaves out — a Workspace
 * member's run, opened from a Task's execution record (#254). It is read by
 * id once the list is read and does not hold it; `pending` until it answers,
 * `session` null when there is no such Session.
 */
export function useOutsideSession(
  api: KubecodeApi,
  projectId: string | null,
  conversationId: string | null,
  listed: readonly Conversation[],
  listRead: boolean,
) {
  const [lookup, setLookup] = useState<Lookup | null>(null)
  const needed = projectId !== null && conversationId !== null && listRead
    && typeof api.getSession === 'function'
    && !listed.some((item) => item.id === conversationId)
  const key = needed ? `${projectId}\u0000${conversationId}` : null

  useEffect(() => {
    if (key === null || projectId === null || conversationId === null) return
    let current = true
    api.getSession(projectId, conversationId).then(
      (session) => { if (current) setLookup({ key, session }) },
      () => { if (current) setLookup({ key, session: null }) },
    )
    return () => { current = false }
  }, [api, conversationId, key, projectId])

  const settled = key !== null && lookup?.key === key ? lookup : null
  return { session: settled?.session ?? null, pending: key !== null && settled === null }
}
