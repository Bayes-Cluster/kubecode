import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError } from '../api'
import type { Conversation, KubecodeApi, WorkspaceEvent } from '../api'

/** Why the server cleared a binding on its own (shown as a recoverable note). */
export type WeChatBindingClearedReason = 'session_removed' | 'session_archived'

/** Why a Session cannot be the WeChat target. */
export type WeChatUnbindableReason = 'archived' | 'read_only' | 'team' | 'missing' | 'unavailable'

export type WeChatBinding = {
  /** A WeChat account is linked on this Runtime. */
  linked: boolean
  boundConversationId: string | null
  clearedReason: WeChatBindingClearedReason | null
  pending: boolean
  rejected: WeChatUnbindableReason | 'failed' | null
  bind: (conversationId: string) => Promise<void>
  unbind: () => Promise<void>
}

const UNBINDABLE_REASONS: ReadonlySet<string> = new Set([
  'archived', 'read_only', 'team', 'missing', 'unavailable',
])

/**
 * Client-side hint for the menu/selector; the server revalidates at submit
 * time and stays authoritative.
 */
export function wechatUnbindableReason(conversation: Conversation): WeChatUnbindableReason | null {
  if (conversation.archived) return 'archived'
  if (conversation.read_only) return 'read_only'
  if (conversation.team_id || conversation.relationship === 'team_member' || conversation.relationship === 'subagent') {
    return 'team'
  }
  return null
}

/**
 * The single active WeChat Session, converged from the server: loaded once,
 * refetched on `ilink_status_changed` events (other tabs, Session removal,
 * logout), and fenced so a stale response never overwrites a newer one.
 */
export function useWeChatBinding(api: KubecodeApi, workspaceEvents: WorkspaceEvent[]): WeChatBinding {
  const available = typeof api.ilinkStatus === 'function'
  const [linked, setLinked] = useState(false)
  const [boundConversationId, setBound] = useState<string | null>(null)
  const [clearedReason, setClearedReason] = useState<WeChatBindingClearedReason | null>(null)
  const [pending, setPending] = useState(false)
  const [rejected, setRejected] = useState<WeChatBinding['rejected']>(null)
  // Loads and mutations are fenced separately: a background reload never
  // cancels a mutation's bookkeeping (pending would stick), while a
  // mutation still invalidates loads that started before it.
  const loadTicket = useRef(0)
  const mutationTicket = useRef(0)
  const processed = useRef(workspaceEvents.at(-1)?.id ?? 0)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (!available) return
    const mine = ++loadTicket.current
    void api.ilinkStatus().then((status) => {
      if (mine !== loadTicket.current) return
      setLinked(Boolean(status.account_id))
      setBound(status.bound_conversation_id)
    }).catch(() => undefined)
  }, [api, available, reload])

  useEffect(() => {
    const changes = workspaceEvents.filter((event) => (
      event.id > processed.current && event.kind === 'ilink_status_changed'
    ))
    processed.current = workspaceEvents.at(-1)?.id ?? processed.current
    const latest = changes.at(-1)?.payload
    if (!latest) return
    const reason = latest.binding_reason
    if (reason === 'session_removed' || reason === 'session_archived') {
      setClearedReason(reason)
    } else if (latest.conversation_id || latest.status === 'disconnected') {
      // A binding exists again, or the account was logged out: the old
      // explanation no longer applies.
      setClearedReason(null)
    }
    setReload((value) => value + 1)
  }, [workspaceEvents])

  const apply = useCallback(async (operation: () => Promise<{ bound_conversation_id: string | null }>) => {
    const mine = ++mutationTicket.current
    loadTicket.current += 1
    setPending(true)
    setRejected(null)
    try {
      const result = await operation()
      if (mine !== mutationTicket.current) return
      setBound(result.bound_conversation_id)
      // The server only accepts a binding change for a linked account.
      setLinked(true)
      setClearedReason(null)
    } catch (error) {
      if (mine !== mutationTicket.current) return
      const reason = error instanceof ApiError ? error.reason ?? '' : ''
      setRejected(UNBINDABLE_REASONS.has(reason) ? reason as WeChatUnbindableReason : 'failed')
      // Re-read the authoritative binding after a refusal.
      setReload((value) => value + 1)
    } finally {
      if (mine === mutationTicket.current) setPending(false)
    }
  }, [])

  const bind = useCallback(
    (conversationId: string) => apply(() => api.ilinkBindSession(conversationId)),
    [api, apply],
  )
  const unbind = useCallback(() => apply(() => api.ilinkUnbindSession()), [api, apply])

  return { linked, boundConversationId, clearedReason, pending, rejected, bind, unbind }
}
