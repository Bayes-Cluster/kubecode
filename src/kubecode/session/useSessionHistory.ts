import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'

import type { AiAgentMessage } from '@/lib/aiAgentConversation'
import { trackEvent } from '@/lib/telemetry'

import type { SideQuestionItem } from '../SideQuestionPanel'
import type {
  AgentEvent,
  AgentRun,
  AgentSessionState,
  Conversation,
  ConversationRevision,
  KubecodeApi,
} from '../api'
import {
  ACTIVE_RUN_STATUSES,
  applyAgentEvent,
  hydrateConversation,
  initialElicitationAnswers,
  messageFromRun,
  messagesFromHistoryPage,
  type ElicitationAnswer,
  type PendingElicitation,
  type PendingPermission,
  type Translator,
} from './sessionModel'

export type SessionTranscript = {
  active: boolean
  attachRun: (nextRun: AgentRun) => void
  elicitationAnswers: Record<string, ElicitationAnswer>
  knownRunIdsRef: { current: Set<string> }
  latestWorkspaceEventIdRef: { current: number }
  loadRun: (runId: string) => Promise<AgentRun>
  messages: AiAgentMessage[]
  pendingElicitation: PendingElicitation | null
  pendingPermission: PendingPermission | null
  pendingRunEventsRef: { current: Map<string, AgentEvent[]> }
  processedWorkspaceEventRef: { current: number }
  run: AgentRun | null
  setElicitationAnswers: Dispatch<SetStateAction<Record<string, ElicitationAnswer>>>
  setMessages: Dispatch<SetStateAction<AiAgentMessage[]>>
  setPendingElicitation: Dispatch<SetStateAction<PendingElicitation | null>>
  setPendingPermission: Dispatch<SetStateAction<PendingPermission | null>>
  setRun: Dispatch<SetStateAction<AgentRun | null>>
  setSideQuestions: Dispatch<SetStateAction<SideQuestionItem[]>>
  sideQuestions: SideQuestionItem[]
}

export type SessionHistoryController = {
  historyCursor: string | null
  loadEarlierHistory: () => Promise<void>
  loadingEarlier: boolean
  regenerate: (runId: string) => Promise<void>
  revisions: ConversationRevision[]
  reviseAtRun: (runId: string, replacement?: string) => Promise<void>
  selectRevision: (index: number) => void
  transcript: SessionTranscript
  viewRevisionId: string | null
}

type UseSessionHistoryOptions = {
  api: KubecodeApi
  beginSessionStateRequest: (
    targetConversationId: string,
  ) => (state: AgentSessionState | null) => void
  conversation: Conversation | null
  conversationId: string | null
  directTeammateChatDisabled: boolean
  hardReadOnly: boolean
  projectId: string | null
  reportError: (cause: unknown) => void
  setComposerCatalogLoadFailed: (value: boolean) => void
  setWorkspaceWarning: (value: string | null) => void
  t: Translator
}

export function useSessionHistory({
  api,
  beginSessionStateRequest,
  conversation,
  conversationId,
  directTeammateChatDisabled,
  hardReadOnly,
  projectId,
  reportError,
  setComposerCatalogLoadFailed,
  setWorkspaceWarning,
  t,
}: UseSessionHistoryOptions): SessionHistoryController {
  const [messages, setMessages] = useState<AiAgentMessage[]>([])
  const [run, setRun] = useState<AgentRun | null>(null)
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null)
  const [pendingElicitation, setPendingElicitation] = useState<PendingElicitation | null>(null)
  const [elicitationAnswers, setElicitationAnswers] = useState<Record<string, ElicitationAnswer>>({})
  const [sideQuestions, setSideQuestions] = useState<SideQuestionItem[]>([])
  const [revisions, setRevisions] = useState<ConversationRevision[]>([])
  const [viewRevisionId, setViewRevisionId] = useState<string | null>(null)
  const [historyCursor, setHistoryCursor] = useState<string | null>(null)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const knownRunIdsRef = useRef(new Set<string>())
  const loadingRunsRef = useRef(new Map<string, Promise<AgentRun>>())
  const pendingRunEventsRef = useRef(new Map<string, AgentEvent[]>())
  const processedWorkspaceEventRef = useRef(0)
  const latestWorkspaceEventIdRef = useRef(0)

  const activeRun = Boolean(run && ACTIVE_RUN_STATUSES.has(run.status))
  const historyConversationId = viewRevisionId ?? conversation?.id ?? null

  const attachRun = useCallback((nextRun: AgentRun) => {
    knownRunIdsRef.current.add(nextRun.id)
    const pending = pendingRunEventsRef.current.get(nextRun.id) ?? []
    pendingRunEventsRef.current.delete(nextRun.id)
    setMessages((current) => {
      const initial = current.some((message) => message.id === nextRun.id)
        ? current
        : [...current, messageFromRun(nextRun)]
      return pending.reduce(
        (history, event) => applyAgentEvent(history, nextRun.id, event),
        initial,
      )
    })
    setRun((current) => (
      current?.id === nextRun.id
        && !ACTIVE_RUN_STATUSES.has(current.status)
        && ACTIVE_RUN_STATUSES.has(nextRun.status)
        ? current
        : nextRun
    ))
  }, [])

  const loadRun = useCallback((runId: string) => {
    const loading = loadingRunsRef.current.get(runId)
    if (loading) return loading
    const request = api.getRun(runId)
    loadingRunsRef.current.set(runId, request)
    void request.then(attachRun).finally(() => loadingRunsRef.current.delete(runId))
    return request
  }, [api, attachRun])

  useEffect(() => {
    setViewRevisionId(null)
    setRevisions([])
    if (!conversationId) return
    if (typeof api.listConversationRevisions !== 'function') return
    void api.listConversationRevisions(conversationId).then(setRevisions).catch(reportError)
  }, [api, conversationId, reportError])

  useEffect(() => {
    if (!conversation || !historyConversationId) return
    knownRunIdsRef.current.clear()
    loadingRunsRef.current.clear()
    pendingRunEventsRef.current.clear()
    processedWorkspaceEventRef.current = latestWorkspaceEventIdRef.current
    let current = true
    const applySessionState = beginSessionStateRequest(conversation.id)
    void hydrateConversation(api, historyConversationId).then(({
      messages: history,
      activeRun: hydratedRun,
      pendingPermission: restoredPermission,
      pendingElicitation: restoredElicitation,
      sessionState: restoredState,
      sideQuestions: restoredSideQuestions,
      historyCursor: restoredCursor,
    }) => {
      if (!current) return
      setMessages(history)
      knownRunIdsRef.current = new Set(
        history.flatMap((message) => message.id ? [message.id] : []),
      )
      setRun(hydratedRun)
      setPendingPermission(restoredPermission)
      setPendingElicitation(restoredElicitation)
      setElicitationAnswers(initialElicitationAnswers(restoredElicitation))
      applySessionState(restoredState)
      setSideQuestions(restoredSideQuestions)
      setHistoryCursor(restoredCursor)
    }).catch((cause: unknown) => {
      if (current) {
        setComposerCatalogLoadFailed(true)
        reportError(cause)
      }
    })
    return () => { current = false }
  }, [
    api,
    beginSessionStateRequest,
    conversation,
    historyConversationId,
    reportError,
    setComposerCatalogLoadFailed,
  ])

  const reviseAtRun = useCallback(async (runId: string, replacement?: string) => {
    if (!conversation
      || !projectId
      || activeRun
      || viewRevisionId
      || directTeammateChatDisabled
      || hardReadOnly) return
    try {
      const revision = await api.reviseConversationAtRun(conversation.id, runId)
      if (revision.workspace_restore === 'kept') {
        setWorkspaceWarning(t('kubecode.revisionFilesKept'))
      }
      const applySessionState = beginSessionStateRequest(conversation.id)
      const hydrated = await hydrateConversation(api, conversation.id)
      knownRunIdsRef.current = new Set(
        hydrated.messages.flatMap((message) => message.id ? [message.id] : []),
      )
      setMessages(hydrated.messages)
      setRun(hydrated.activeRun)
      setPendingPermission(hydrated.pendingPermission)
      setPendingElicitation(hydrated.pendingElicitation)
      setElicitationAnswers(initialElicitationAnswers(hydrated.pendingElicitation))
      applySessionState(hydrated.sessionState)
      setSideQuestions(hydrated.sideQuestions)
      setHistoryCursor(hydrated.historyCursor)
      setViewRevisionId(null)
      setRevisions(await api.listConversationRevisions(conversation.id))
      if (replacement?.trim()) {
        attachRun(await api.startRun(projectId, conversation.id, replacement.trim()))
      }
      trackEvent('agent_message_revision_created', {
        action: replacement ? 'regenerate' : 'undo',
        agent_id: conversation.agent_id,
      })
    } catch (cause) {
      reportError(cause)
    }
  }, [
    api,
    attachRun,
    activeRun,
    beginSessionStateRequest,
    conversation,
    directTeammateChatDisabled,
    hardReadOnly,
    projectId,
    reportError,
    setWorkspaceWarning,
    t,
    viewRevisionId,
  ])

  const regenerate = useCallback(async (runId: string) => {
    const message = messages.find((candidate) => candidate.id === runId)?.userMessage
    if (message) await reviseAtRun(runId, message)
  }, [messages, reviseAtRun])

  const loadEarlierHistory = useCallback(async () => {
    if (!historyConversationId || !historyCursor || loadingEarlier) return
    setLoadingEarlier(true)
    try {
      const page = await api.getConversationHistory(historyConversationId, historyCursor)
      const older = messagesFromHistoryPage(page)
      setMessages((current) => {
        const currentIds = new Set(current.flatMap((message) => message.id ? [message.id] : []))
        return [
          ...older.filter((message) => !message.id || !currentIds.has(message.id)),
          ...current,
        ]
      })
      setHistoryCursor(page.next_cursor)
    } catch (cause) {
      reportError(cause)
    } finally {
      setLoadingEarlier(false)
    }
  }, [api, historyConversationId, historyCursor, loadingEarlier, reportError])

  const selectRevision = useCallback((index: number) => {
    setViewRevisionId(index === revisions.length
      ? null
      : revisions[index]?.snapshot_conversation_id ?? null)
  }, [revisions])

  return {
    historyCursor,
    loadEarlierHistory,
    loadingEarlier,
    regenerate,
    revisions,
    reviseAtRun,
    selectRevision,
    transcript: {
      active: activeRun,
      attachRun,
      elicitationAnswers,
      knownRunIdsRef,
      latestWorkspaceEventIdRef,
      loadRun,
      messages,
      pendingElicitation,
      pendingPermission,
      pendingRunEventsRef,
      processedWorkspaceEventRef,
      run,
      setElicitationAnswers,
      setMessages,
      setPendingElicitation,
      setPendingPermission,
      setRun,
      setSideQuestions,
      sideQuestions,
    },
    viewRevisionId,
  }
}
