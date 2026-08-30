import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'

import type { AiAgentMessage } from '@/lib/aiAgentConversation'
import type { Translator } from '@/lib/i18n'
import { trackEvent } from '@/lib/telemetry'

import type { SideQuestionItem } from '../SideQuestionPanel'
import type {
  AgentRun,
  AgentSessionState,
  Conversation,
  ConversationRevision,
  KubecodeApi,
  PromptQueueItem,
} from '../api'
import type { SubagentEntry } from './conversationReducer'
import {
  ACTIVE_RUN_STATUSES,
  createConversationPump,
  TERMINAL_RUN_STATUSES,
  initialConversationState,
  mergeLiveOverHistory,
  reduceConversation,
  textValue,
} from './conversationReducer'
import type {
  ConversationInput,
  ConversationState,
  ElicitationAnswer,
  PendingElicitation,
  PendingPermission,
  TerminalCause,
  TimelineEvent,
} from './conversationReducer'
import { hydrateConversation, initialElicitationAnswers, messagesFromHistoryPage } from './sessionModel'

export type SessionTranscript = {
  active: boolean
  appendOptimisticMessage: (message: AiAgentMessage) => void
  attachRun: (nextRun: AgentRun) => void
  /**
   * Live conversation events enter here: one frame-budgeted queue feeding the
   * same reducer history hydration replays through (#103).
   */
  enqueueConversationEvents: (events: readonly TimelineEvent[]) => void
  promptQueue: PromptQueueItem[]
  setPromptQueue: Dispatch<SetStateAction<PromptQueueItem[]>>
  subagents: SubagentEntry[]
  setSubagents: Dispatch<SetStateAction<SubagentEntry[]>>
  elicitationAnswers: Record<string, ElicitationAnswer>
  failOptimisticMessage: (clientMessageId: string) => void
  messages: AiAgentMessage[]
  pendingElicitation: PendingElicitation | null
  pendingPermission: PendingPermission | null
  removeOptimisticMessage: (clientMessageId: string) => void
  run: AgentRun | null
  setElicitationAnswers: Dispatch<SetStateAction<Record<string, ElicitationAnswer>>>
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
  /** Fired when a watched run turns terminal with a typed cause (#93). */
  onRunTerminal?: (cause: TerminalCause, run: AgentRun) => void
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
  onRunTerminal,
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
  const [promptQueue, setPromptQueue] = useState<PromptQueueItem[]>([])
  const [subagents, setSubagents] = useState<SubagentEntry[]>([])
  const [revisions, setRevisions] = useState<ConversationRevision[]>([])
  const [viewRevisionId, setViewRevisionId] = useState<string | null>(null)
  const [historyCursor, setHistoryCursor] = useState<string | null>(null)
  const [loadingEarlier, setLoadingEarlier] = useState(false)

  /**
   * Single source of truth for transcript state (#103): React mirrors commit
   * from this kernel, so every mutation lives in exactly one reducer.
   */
  const kernelRef = useRef<ConversationState>(initialConversationState())
  /** Inputs folded while an in-flight hydration merges on top afterwards. */
  const bufferedInputsRef = useRef<ConversationInput[]>([])
  const hydratingRef = useRef(false)
  const inflightRunsRef = useRef(new Map<string, Promise<AgentRun>>())
  /** Terminal causes already surfaced, keyed conversation:run:cause. */
  const notifiedTerminalRef = useRef(new Set<string>())
  const onRunTerminalRef = useRef(onRunTerminal)
  onRunTerminalRef.current = onRunTerminal

  const activeRun = Boolean(run && ACTIVE_RUN_STATUSES.has(run.status))
  const historyConversationId = viewRevisionId ?? conversation?.id ?? null

  /**
   * Commits kernel state to its React mirrors with reference guards. Run-row
   * changes mirror into the header's watched run here — including terminal
   * convergence from the typed cause (#92/#93) — so nothing depends on a
   * refetch, while the terminal-stickiness rule stays authoritative.
   */
  const commit = useCallback((previous: ConversationState, next: ConversationState) => {
    kernelRef.current = next
    if (next.messages !== previous.messages) setMessages(next.messages)
    if (next.pendingPermission !== previous.pendingPermission) {
      setPendingPermission(next.pendingPermission)
    }
    if (next.pendingElicitation !== previous.pendingElicitation) {
      setPendingElicitation(next.pendingElicitation)
      if (next.pendingElicitation && previous.pendingElicitation?.requestId
        !== next.pendingElicitation.requestId) {
        setElicitationAnswers(initialElicitationAnswers(next.pendingElicitation))
      }
    }
    if (next.sideQuestions !== previous.sideQuestions) setSideQuestions(next.sideQuestions)
    if (next.subagents !== previous.subagents) setSubagents(Object.values(next.subagents))

    const observations: Array<[TerminalCause, AgentRun]> = []
    const conversationKey = conversation?.id ?? ''
    for (const [runId, nextRun] of Object.entries(next.runs)) {
      if (previous.runs[runId] === nextRun) continue
      // Header run stays sticky: once terminal, a later stale "running" row
      // for the same id never flips it back to active.
      setRun((current) => (
        current?.id === nextRun.id
          && !ACTIVE_RUN_STATUSES.has(current.status)
          && ACTIVE_RUN_STATUSES.has(nextRun.status)
          ? current
          : current?.id === nextRun.id
            ? { ...current, ...nextRun }
            : nextRun
      ))
      if (hydratingRef.current || !onRunTerminalRef.current) continue
      const wasActiveOrNew = !previous.runs[runId]
        || ACTIVE_RUN_STATUSES.has(previous.runs[runId].status)
      const cause = nextRun.terminal_cause
      if (cause && wasActiveOrNew && TERMINAL_RUN_STATUSES.has(nextRun.status)) {
        const key = `${conversationKey}:${runId}:${cause}`
        if (!notifiedTerminalRef.current.has(key)) {
          notifiedTerminalRef.current.add(key)
          observations.push([cause, nextRun])
        }
      }
    }
    for (const [cause, observed] of observations) onRunTerminalRef.current?.(cause, observed)
  }, [conversation])

  const commitKernelState = useCallback((next: ConversationState) => {
    commit(kernelRef.current, next)
  }, [commit])

  const dispatch = useCallback((input: ConversationInput) => {
    if (hydratingRef.current) {
      bufferedInputsRef.current.push(input)
      return
    }
    const previous = kernelRef.current
    commit(previous, reduceConversation(previous, input))
  }, [commit])

  const attachRun = useCallback((nextRun: AgentRun) => {
    // The header's watched run mirrors this through the central commit.
    dispatch({ type: 'run', run: nextRun })
  }, [dispatch])

  const loadRun = useCallback((runId: string) => {
    const loading = inflightRunsRef.current.get(runId)
    if (loading) return loading
    const request = api.getRun(runId).then((loaded) => {
      attachRun(loaded)
      return loaded
    }).finally(() => inflightRunsRef.current.delete(runId))
    inflightRunsRef.current.set(runId, request)
    return request
  }, [api, attachRun])

  /**
   * Fello-style pump (#103): bounded batches under an 8ms frame budget so a
   * heavy stream never renders as one long task. Missing run rows discovered
   * while draining trigger exactly one fetch whose arrival drains the
   * kernel's own per-run buffers.
   */
  const drainBatchRef = useRef<(batch: readonly TimelineEvent[]) => void>(() => {})
  const pump = useMemo(() => createConversationPump<TimelineEvent>({
    budgetMs: 8,
    onDrain: (batch) => drainBatchRef.current(batch),
  }), [])
  useEffect(() => () => pump.dispose(), [pump])

  drainBatchRef.current = (batch) => {
    let next = kernelRef.current
    const unknownRuns = new Set<string>()
    for (const event of batch) {
      const previous = next
      next = hydratingRef.current ? next : reduceConversation(next, { type: 'event', event })
      if (!hydratingRef.current && next === previous) continue
      const runId = textValue(event.payload.run_id) || event.runId
      if (runId && !next.runs[runId] && !inflightRunsRef.current.has(runId)) {
        unknownRuns.add(runId)
      }
    }
    if (hydratingRef.current) {
      for (const event of batch) {
        bufferedInputsRef.current.push({ type: 'event', event })
      }
      return
    }
    commitKernelState(next)
    for (const runId of unknownRuns) {
      void loadRun(runId).catch(() => {
        // The kernel keeps the events buffered; transport-level retries are
        // the reconnect story (#102), not this path.
      })
    }
  }

  const enqueueConversationEvents = useCallback((events: readonly TimelineEvent[]) => {
    for (const event of events) pump.push(event)
  }, [pump])

  useEffect(() => {
    setViewRevisionId(null)
    setRevisions([])
    if (!conversationId) return
    if (typeof api.listConversationRevisions !== 'function') return
    void api.listConversationRevisions(conversationId).then(setRevisions).catch(reportError)
  }, [api, conversationId, reportError])

  useEffect(() => {
    if (!conversation || !historyConversationId) return
    let cancelled = false
    hydratingRef.current = true
    bufferedInputsRef.current = []
    const applySessionState = beginSessionStateRequest(conversation.id)
    hydrateConversation(api, historyConversationId).then((result) => {
      if (cancelled) return
      hydratingRef.current = false
      const buffered = bufferedInputsRef.current
      bufferedInputsRef.current = []
      const merged = mergeLiveOverHistory(result.state, buffered, result.workspaceCursor)
      kernelRef.current = merged
      setMessages(merged.messages)
      setPendingPermission(merged.pendingPermission)
      setPendingElicitation(merged.pendingElicitation)
      if (merged.pendingElicitation) {
        setElicitationAnswers(initialElicitationAnswers(merged.pendingElicitation))
      }
      setSideQuestions(merged.sideQuestions)
      setSubagents(Object.values(merged.subagents))
      setRun(result.activeRun)
      applySessionState(result.sessionState)
      setHistoryCursor(result.historyCursor)
      // Seed the queue surface; live prompt_queue snapshots maintain it.
      // The guard keeps older API surfaces (tests, runtimes) rendering.
      if (typeof api.listPromptQueue === 'function') {
        void api.listPromptQueue(historyConversationId).then((items) => {
          if (!cancelled) setPromptQueue(items)
        }).catch(() => {
          if (!cancelled) setPromptQueue([])
        })
      }
      for (const runId of collectMissingRunIds(buffered, merged)) {
        void loadRun(runId).catch(() => {})
      }
    }).catch((cause: unknown) => {
      hydratingRef.current = false
      if (!cancelled) {
        setComposerCatalogLoadFailed(true)
        reportError(cause)
      }
    })
    return () => {
      cancelled = true
      hydratingRef.current = false
    }
  }, [
    api,
    beginSessionStateRequest,
    conversation,
    historyConversationId,
    loadRun,
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
      const hydrated = await hydrateConversation(api, conversation.id)
      const buffered = bufferedInputsRef.current
      bufferedInputsRef.current = []
      const merged = mergeLiveOverHistory(hydrated.state, buffered, hydrated.workspaceCursor)
      kernelRef.current = merged
      setMessages(merged.messages)
      setPendingPermission(merged.pendingPermission)
      setPendingElicitation(merged.pendingElicitation)
      if (merged.pendingElicitation) {
        setElicitationAnswers(initialElicitationAnswers(merged.pendingElicitation))
      }
      setSideQuestions(merged.sideQuestions)
      setRun(hydrated.activeRun)
      const applySessionState = beginSessionStateRequest(conversation.id)
      applySessionState(hydrated.sessionState)
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

  const regenerate = useCallback(async (targetRunId: string) => {
    const message = messages.find((candidate) => candidate.id === targetRunId)?.userMessage
    if (message) await reviseAtRun(targetRunId, message)
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

  const appendOptimisticMessage = useCallback((message: AiAgentMessage) => {
    dispatch({ type: 'optimistic', message })
  }, [dispatch])
  const removeOptimisticMessage = useCallback((clientMessageId: string) => {
    dispatch({ type: 'rollback_optimistic', clientMessageId })
  }, [dispatch])
  const failOptimisticMessage = useCallback((clientMessageId: string) => {
    dispatch({ type: 'fail_optimistic', clientMessageId })
  }, [dispatch])

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
      appendOptimisticMessage,
      attachRun,
      enqueueConversationEvents,
      elicitationAnswers,
      failOptimisticMessage,
      messages,
      pendingElicitation,
      pendingPermission,
      removeOptimisticMessage,
      run,
      setElicitationAnswers,
      setPendingElicitation,
      setPendingPermission,
      setRun,
      setPromptQueue,
      promptQueue,
      setSideQuestions,
      setSubagents,
      sideQuestions,
      subagents,
    },
    viewRevisionId,
  }
}

/** Run ids referenced by inputs but absent from the merged kernel state. */
function collectMissingRunIds(
  inputs: readonly ConversationInput[],
  state: ConversationState,
): Set<string> {
  const missing = new Set<string>()
  for (const input of inputs) {
    if (input.type !== 'event') continue
    const runId = input.event.runId
    if (runId && !state.runs[runId]) missing.add(runId)
  }
  return missing
}
