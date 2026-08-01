import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { ComposerCatalogSnapshot, KubecodeApi, AgentSessionState } from '../api'

import { sessionPlanEntries } from './sessionModel'

type UseSessionStateOptions = {
  api: KubecodeApi
  conversationId: string | null
}

export type SessionStateController = {
  applyComposerCatalog: (catalog: ComposerCatalogSnapshot) => void
  beginSessionStateRequest: (
    targetConversationId: string,
  ) => (state: AgentSessionState | null) => void
  capabilityStatus: 'error' | 'loading' | 'ready'
  composerCatalogLoadFailed: boolean
  planEntries: ReturnType<typeof sessionPlanEntries>
  requestSessionState: (targetConversationId: string) => Promise<void>
  sessionState: AgentSessionState | null
  setComposerCatalogLoadFailed: (value: boolean) => void
  setSessionState: React.Dispatch<React.SetStateAction<AgentSessionState | null>>
}

export function useSessionState({
  api,
  conversationId,
}: UseSessionStateOptions): SessionStateController {
  const [sessionState, setSessionState] = useState<AgentSessionState | null>(null)
  const [composerCatalogLoadFailed, setComposerCatalogLoadFailed] = useState(false)
  const sessionStateRequestRef = useRef(0)
  const activeConversationIdRef = useRef(conversationId)

  useEffect(() => {
    activeConversationIdRef.current = conversationId
  }, [conversationId])

  const [previousConversationId, setPreviousConversationId] = useState(conversationId)
  if (previousConversationId !== conversationId) {
    setPreviousConversationId(conversationId)
    setComposerCatalogLoadFailed(false)
  }

  const beginSessionStateRequest = useCallback((targetConversationId: string) => {
    if (activeConversationIdRef.current !== targetConversationId) return () => undefined
    const request = ++sessionStateRequestRef.current
    return (state: AgentSessionState | null) => {
      if (request === sessionStateRequestRef.current
        && activeConversationIdRef.current === targetConversationId) {
        setSessionState(state)
        if (state) setComposerCatalogLoadFailed(false)
      }
    }
  }, [])

  const requestSessionState = useCallback(async (targetConversationId: string) => {
    if (activeConversationIdRef.current !== targetConversationId) return
    const applyState = beginSessionStateRequest(targetConversationId)
    try {
      applyState(await api.getSessionState(targetConversationId))
    } catch (cause) {
      if (activeConversationIdRef.current === targetConversationId) {
        setComposerCatalogLoadFailed(true)
      }
      throw cause
    }
  }, [api, beginSessionStateRequest])

  const applyComposerCatalog = useCallback((catalog: ComposerCatalogSnapshot) => {
    if (catalog.conversation_id !== conversationId) return
    setSessionState((current) => current ? { ...current, composer: { catalog } } : current)
  }, [conversationId])

  const planEntries = useMemo(
    () => sessionPlanEntries(sessionState?.plan),
    [sessionState?.plan],
  )

  const capabilityStatus = composerCatalogLoadFailed
    ? 'error' as const
    : sessionState ? 'ready' as const : 'loading' as const

  return {
    applyComposerCatalog,
    beginSessionStateRequest,
    capabilityStatus,
    composerCatalogLoadFailed,
    planEntries,
    requestSessionState,
    sessionState,
    setComposerCatalogLoadFailed,
    setSessionState,
  }
}
