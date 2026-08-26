import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react'

import type { AiAgentMessage } from '@/lib/aiAgentConversation'
import type { Translator } from '@/lib/i18n'
import { trackEvent } from '@/lib/telemetry'

import { ApiError } from '../api'
import type { ComposerCapabilityPickerLabels } from '../ComposerCapabilityPicker'
import type {
  SessionTurnContextRequest,
  SessionTurnContextSource,
  TerminalContextRequest,
} from '../ComposerAddMenu'
import type { Entry, GitDiffContextCandidate, KubecodeApi } from '../api'
import type {
  AgentDescriptor,
  AgentRun,
  AgentSessionState,
  ComposerCatalogSnapshot,
  Conversation,
} from '../api'
import type { RankedComposerCapability } from '../composerCapabilities'
import {
  acpCommandCanDispatch,
  activeAcpCommand,
  completeAcpCommand,
  matchingAcpCommands,
  type ActiveAcpCommand,
  type AcpCommand,
} from '../acpCommands'
import {
  appendComposerCapability,
  appendComposerContext,
  appendComposerText,
  applyComposerCatalogSnapshot,
  composerDraftHasStaleContext,
  composerDraftHasTypedReferences,
  composerDraftPlainText,
  composerDraftToStructuredSegments,
  createComposerCapabilityReference,
  createComposerContextReference,
  parseStoredComposerDraft,
  serializeComposerDraft,
  textComposerDraft,
  type ComposerDraft,
} from '../composerDraft'
import type { SideQuestionItem } from '../SideQuestionPanel'
import {
  agentResponseText,
  applySideQuestionEvent,
  canAskSideQuestion,
  capabilityDisabledReason,
  gitDiffDisabledReason,
  MAX_SESSION_TURN_PICKER_SOURCES,
  newClientMessageId,
  optimisticUserMessage,
  sessionTurnPreview,
  sideQuestionText,
} from './sessionModel'

const SESSION_DRAFT_PREFIX = 'kubecode:session-draft:'

function readSessionDraft(conversationId: string): ComposerDraft {
  try {
    return parseStoredComposerDraft(
      globalThis.sessionStorage?.getItem(`${SESSION_DRAFT_PREFIX}${conversationId}`),
    )
  } catch {
    return textComposerDraft()
  }
}

function writeSessionDraft(conversationId: string, draft: ComposerDraft) {
  try {
    if (composerDraftPlainText(draft)) {
      globalThis.sessionStorage?.setItem(
        `${SESSION_DRAFT_PREFIX}${conversationId}`,
        serializeComposerDraft(draft),
      )
    } else {
      globalThis.sessionStorage?.removeItem(`${SESSION_DRAFT_PREFIX}${conversationId}`)
    }
  } catch {
    // Draft persistence must never make the Composer unavailable.
  }
}

export type ComposerController = {
  activeCommand: ActiveAcpCommand | null
  capabilityLabels: ComposerCapabilityPickerLabels
  composerContextPending: boolean
  composerDraft: ComposerDraft
  composerHasTypedReferences: boolean
  composerSubmitDisabled: boolean
  currentCommandIndex: number
  gitDiffLabels: {
    all: string
    disabled: (reason: string | null) => string
    summary: (candidate: {
      file_count: number
      hunk_count: number
      byte_count: number
    }) => string
  }
  handleCommandKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
  inputRef: RefObject<HTMLDivElement | null>
  insertComposerCapability: (capability: RankedComposerCapability) => void
  insertComposerContext: (entry: Entry) => void
  insertComposerGitDiff: (candidate: GitDiffContextCandidate) => void
  insertComposerSessionTurnContext: (turnRequest: SessionTurnContextRequest) => void
  insertComposerTerminalContext: (terminalRequest: TerminalContextRequest) => void
  insertComposerText: (text: string, kind: 'command') => void
  prompt: string
  send: (text: string) => Promise<void>
  sendSideQuestion: (text: string) => Promise<void>
  sessionTurnSources: SessionTurnContextSource[]
  setDismissedCommandPrompt: Dispatch<SetStateAction<string | null>>
  setInlineContextPending: Dispatch<SetStateAction<boolean>>
  setSelectedCommandIndex: Dispatch<SetStateAction<number>>
  updateComposerDraft: (next: ComposerDraft | ((current: ComposerDraft) => ComposerDraft)) => void
  updatePrompt: (next: string | ((current: string) => string)) => void
  visibleCommands: AcpCommand[]
}

type UseComposerControllerOptions = {
  active: boolean
  agent: AgentDescriptor | undefined
  api: KubecodeApi
  appendOptimisticMessage: (message: AiAgentMessage) => void
  attachRun: (nextRun: AgentRun) => void
  commands: AcpCommand[]
  conversation: Conversation | null
  conversationId: string | null
  directTeammateChatDisabled: boolean
  failOptimisticMessage: (clientMessageId: string) => void
  hardReadOnly: boolean
  messages: AiAgentMessage[]
  onApplyComposerCatalog: (catalog: import('../api').ComposerCatalogSnapshot) => void
  onClearError: () => void
  projectId: string | null
  removeOptimisticMessage: (clientMessageId: string) => void
  reportError: (cause: unknown) => void
  run: AgentRun | null
  sessionState: AgentSessionState | null
  setSideQuestions: (update: (current: SideQuestionItem[]) => SideQuestionItem[]) => void
  t: Translator
  viewRevisionId: string | null
}

export function useComposerController({
  active,
  agent,
  api,
  appendOptimisticMessage,
  attachRun,
  commands,
  conversation,
  conversationId,
  directTeammateChatDisabled,
  failOptimisticMessage,
  hardReadOnly,
  messages,
  onApplyComposerCatalog,
  onClearError,
  projectId,
  removeOptimisticMessage,
  reportError,
  run,
  sessionState,
  setSideQuestions,
  t,
  viewRevisionId,
}: UseComposerControllerOptions): ComposerController {
  const [composerDraft, setComposerDraft] = useState<ComposerDraft>(
    () => (conversationId ? readSessionDraft(conversationId) : textComposerDraft()),
  )
  const [inlineContextPending, setInlineContextPending] = useState(false)
  const [menuContextPending, setMenuContextPending] = useState(false)
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0)
  const [dismissedCommandPrompt, setDismissedCommandPrompt] = useState<string | null>(null)
  const inputRef = useRef<HTMLDivElement>(null)
  const conversationDraftsRef = useRef(new Map<string, ComposerDraft>())
  const menuContextRequestRef = useRef(0)
  const activeConversationIdRef = useRef(conversationId)
  const pendingRetryClientIdRef = useRef<string | null>(null)

  useEffect(() => {
    activeConversationIdRef.current = conversationId
    pendingRetryClientIdRef.current = null
  }, [conversationId])

  const [previousConversationId, setPreviousConversationId] = useState(conversationId)
  if (previousConversationId !== conversationId) {
    setPreviousConversationId(conversationId)
    setMenuContextPending(false)
    setComposerDraft(conversationId ? readSessionDraft(conversationId) : textComposerDraft())
  }

  const composerContextPending = inlineContextPending || menuContextPending
  const prompt = composerDraftPlainText(composerDraft)
  const composerHasTypedReferences = composerDraftHasTypedReferences(composerDraft)
  const composerCatalogReady = !composerHasTypedReferences
    || sessionState?.composer?.catalog.conversation_id === conversationId
  const composerSubmitDisabled = composerContextPending
    || composerDraftHasStaleContext(composerDraft)
    || !composerCatalogReady

  const sessionTurnSources = useMemo<SessionTurnContextSource[]>(() => {
    if (hardReadOnly || viewRevisionId) return []
    return messages
      .filter((message) => !message.internal && !message.isStreaming && message.id)
      .slice(-MAX_SESSION_TURN_PICKER_SOURCES)
      .map((message) => ({
        turnId: message.id as string,
        userPreview: sessionTurnPreview(message.userMessage),
        agentPreview: sessionTurnPreview(agentResponseText(message)),
      }))
      .filter((source) => source.userPreview || source.agentPreview)
  }, [hardReadOnly, messages, viewRevisionId])

  const capabilityLabels = useMemo<ComposerCapabilityPickerLabels>(() => ({
    disabledReason: (reason) => capabilityDisabledReason(reason, t),
    empty: t('kubecode.noCapabilitiesFound'),
    error: t('kubecode.capabilitiesLoadFailed'),
    kind: {
      skill: t('kubecode.capabilityKindSkill'),
      plugin_action: t('kubecode.capabilityKindPluginAction'),
      provider_app: t('kubecode.capabilityKindProviderApp'),
    },
    loading: t('kubecode.loadingCapabilities'),
    picker: t('kubecode.capabilities'),
    scope: {
      session: t('kubecode.capabilityScopeSession'),
      project: t('kubecode.capabilityScopeProject'),
      user: t('kubecode.capabilityScopeUser'),
      bundled: t('kubecode.capabilityScopeBundled'),
      plugin: t('kubecode.capabilityScopePlugin'),
    },
  }), [t])

  const gitDiffLabels = useMemo(() => ({
    all: t('kubecode.gitDiffAllContext'),
    disabled: (reason: string | null) => gitDiffDisabledReason(reason, t),
    summary: (candidate: {
      file_count: number
      hunk_count: number
      byte_count: number
    }) => t('kubecode.gitDiffSummary', {
      files: candidate.file_count,
      hunks: candidate.hunk_count,
      bytes: candidate.byte_count,
    }),
  }), [t])

  const updatePrompt = useCallback((next: string | ((current: string) => string)) => {
    setSelectedCommandIndex(0)
    setDismissedCommandPrompt(null)
    setComposerDraft((currentDraft) => {
      const current = composerDraftPlainText(currentDraft)
      const value = typeof next === 'function' ? next(current) : next
      const draft = textComposerDraft(value)
      if (conversationId) {
        conversationDraftsRef.current.set(conversationId, draft)
        writeSessionDraft(conversationId, draft)
      }
      return draft
    })
  }, [conversationId])

  const updateComposerDraft = useCallback((
    next: ComposerDraft | ((current: ComposerDraft) => ComposerDraft),
  ) => {
    setSelectedCommandIndex(0)
    setDismissedCommandPrompt(null)
    setComposerDraft((current) => {
      const draft = typeof next === 'function' ? next(current) : next
      if (conversationId) {
        conversationDraftsRef.current.set(conversationId, draft)
        writeSessionDraft(conversationId, draft)
      }
      return draft
    })
  }, [conversationId])

  useEffect(() => {
    menuContextRequestRef.current += 1
  }, [conversationId])

  const catalog = sessionState?.composer?.catalog
  const [previousCatalog, setPreviousCatalog] = useState<ComposerCatalogSnapshot | null>(null)
  if (catalog && catalog.conversation_id === conversationId
    && previousCatalog !== catalog) {
    setPreviousCatalog(catalog)
    setSelectedCommandIndex(0)
    setDismissedCommandPrompt(null)
    setComposerDraft((current) => {
      const draft = applyComposerCatalogSnapshot(current, catalog)
      if (conversationId) writeSessionDraft(conversationId, draft)
      return draft
    })
  }

  const activeCommand = activeAcpCommand(prompt)
  const visibleCommands = !directTeammateChatDisabled
    && activeCommand
    && dismissedCommandPrompt !== prompt
    ? matchingAcpCommands(commands, activeCommand.name)
    : []
  const currentCommandIndex = visibleCommands.length === 0
    ? 0
    : Math.min(selectedCommandIndex, visibleCommands.length - 1)

  const handleCommandKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (visibleCommands.length === 0 || !activeCommand
      || event.isDefaultPrevented()
      || event.nativeEvent.isComposing
      || event.keyCode === 229) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setDismissedCommandPrompt(prompt)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      setSelectedCommandIndex((current) => (
        (current + direction + visibleCommands.length) % visibleCommands.length
      ))
      return
    }
    const selected = visibleCommands[currentCommandIndex]
    if (event.key === 'Tab') {
      if (selected.ambiguous || selected.input.kind === 'unsupported') return
      event.preventDefault()
      event.stopPropagation()
      updatePrompt(completeAcpCommand(selected))
      window.requestAnimationFrame(() => inputRef.current?.focus())
      return
    }
    if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
      return
    }
    if (selected.privateSideQuestion) {
      if (!activeCommand.arguments) return
      event.preventDefault()
      event.stopPropagation()
      void sendSideQuestion(prompt)
      return
    }
    if (!acpCommandCanDispatch(selected, activeCommand)) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (composerDraftHasTypedReferences(composerDraft)) void send(prompt)
    else void dispatchCommand(selected, activeCommand.arguments)
  }

  const insertComposerText = (text: string, kind: 'command') => {
    if (!conversation || directTeammateChatDisabled || hardReadOnly) return
    updateComposerDraft((current) => appendComposerText(current, text))
    window.requestAnimationFrame(() => inputRef.current?.focus())
    trackEvent('kubecode_agent_context_inserted', {
      agent_id: conversation.agent_id,
      kind,
    })
  }

  const insertComposerContext = (entry: Entry) => {
    if (!conversation || directTeammateChatDisabled || hardReadOnly) return
    const targetConversationId = conversation.id
    const request = ++menuContextRequestRef.current
    setMenuContextPending(true)
    void api.registerComposerContext(targetConversationId, {
      kind: entry.kind,
      path: entry.path,
    }).then((registration) => {
      if (request !== menuContextRequestRef.current
        || activeConversationIdRef.current !== targetConversationId
        || registration.context.kind !== entry.kind
        || registration.context.display !== entry.path
        || !registration.context.enabled) return
      onApplyComposerCatalog(registration.catalog)
      updateComposerDraft((current) => appendComposerContext(
        current,
        createComposerContextReference({
          catalogRevision: registration.catalog.revision,
          id: registration.context.id,
          kind: registration.context.kind,
          name: entry.name,
          path: registration.context.display,
        }),
      ))
      window.requestAnimationFrame(() => inputRef.current?.focus())
      trackEvent('kubecode_agent_context_inserted', {
        agent_id: conversation.agent_id,
        kind: entry.kind,
      })
    }).catch((cause) => {
      if (request === menuContextRequestRef.current
        && activeConversationIdRef.current === targetConversationId) {
        reportError(cause)
      }
    }).finally(() => {
      if (request === menuContextRequestRef.current
        && activeConversationIdRef.current === targetConversationId) {
        setMenuContextPending(false)
      }
    })
  }

  const insertComposerGitDiff = (candidate: GitDiffContextCandidate) => {
    if (!conversation || directTeammateChatDisabled || hardReadOnly || !candidate.enabled) return
    const targetConversationId = conversation.id
    const request = ++menuContextRequestRef.current
    setMenuContextPending(true)
    void api.registerComposerContext(targetConversationId, {
      kind: 'git_diff',
      path: candidate.path ?? '.',
      source_revision: candidate.source_revision,
    }).then((registration) => {
      if (request !== menuContextRequestRef.current
        || activeConversationIdRef.current !== targetConversationId
        || registration.context.kind !== 'git_diff'
        || !registration.context.enabled
        || registration.context.summary?.kind !== 'git_diff') return
      onApplyComposerCatalog(registration.catalog)
      updateComposerDraft((current) => appendComposerContext(
        current,
        createComposerContextReference({
          catalogRevision: registration.catalog.revision,
          id: registration.context.id,
          kind: 'git_diff',
          name: candidate.path?.split('/').at(-1) ?? gitDiffLabels.all,
          path: candidate.path ?? 'git-diff',
          summary: registration.context.summary,
        }),
      ))
      window.requestAnimationFrame(() => inputRef.current?.focus())
      trackEvent('kubecode_agent_context_inserted', {
        agent_id: conversation.agent_id,
        kind: 'git_diff',
      })
    }).catch((cause) => {
      if (request === menuContextRequestRef.current
        && activeConversationIdRef.current === targetConversationId) {
        reportError(cause)
      }
    }).finally(() => {
      if (request === menuContextRequestRef.current
        && activeConversationIdRef.current === targetConversationId) {
        setMenuContextPending(false)
      }
    })
  }

  const insertComposerTerminalContext = (terminalRequest: TerminalContextRequest) => {
    if (!conversation || directTeammateChatDisabled || hardReadOnly) return
    const targetConversationId = conversation.id
    const request = ++menuContextRequestRef.current
    setMenuContextPending(true)
    void api.registerComposerContext(targetConversationId, {
      kind: 'terminal',
      path: terminalRequest.capture,
      terminal_id: terminalRequest.terminalId,
      selected_text: terminalRequest.selectedText,
    }).then((registration) => {
      if (request !== menuContextRequestRef.current
        || activeConversationIdRef.current !== targetConversationId
        || registration.context.kind !== 'terminal'
        || !registration.context.enabled
        || registration.context.summary?.kind !== 'terminal') return
      const summary = registration.context.summary
      const pane = t('kubecode.terminalPane', { index: summary.pane_index })
      const capture = t(summary.capture === 'selection'
        ? 'kubecode.terminalCaptureSelection'
        : 'kubecode.terminalCaptureRecent')
      const name = t(summary.truncated
        ? 'kubecode.terminalContextSummaryTruncated'
        : 'kubecode.terminalContextSummary', {
        pane,
        capture,
        lines: summary.line_count,
        bytes: summary.byte_count,
      })
      onApplyComposerCatalog(registration.catalog)
      updateComposerDraft((current) => appendComposerContext(
        current,
        createComposerContextReference({
          catalogRevision: registration.catalog.revision,
          id: registration.context.id,
          kind: 'terminal',
          name,
          path: 'terminal',
          summary,
        }),
      ))
      window.requestAnimationFrame(() => inputRef.current?.focus())
      trackEvent('kubecode_agent_context_inserted', {
        agent_id: conversation.agent_id,
        kind: 'terminal',
      })
    }).catch((cause) => {
      if (request === menuContextRequestRef.current
        && activeConversationIdRef.current === targetConversationId) {
        reportError(cause)
      }
    }).finally(() => {
      if (request === menuContextRequestRef.current
        && activeConversationIdRef.current === targetConversationId) {
        setMenuContextPending(false)
      }
    })
  }

  const insertComposerSessionTurnContext = (turnRequest: SessionTurnContextRequest) => {
    if (!conversation || directTeammateChatDisabled || hardReadOnly || viewRevisionId) return
    const targetConversationId = conversation.id
    const request = ++menuContextRequestRef.current
    setMenuContextPending(true)
    void api.registerComposerContext(targetConversationId, {
      kind: 'session_turn',
      path: turnRequest.role,
      turn_id: turnRequest.turnId,
    }).then((registration) => {
      if (request !== menuContextRequestRef.current
        || activeConversationIdRef.current !== targetConversationId
        || registration.context.kind !== 'session_turn'
        || !registration.context.enabled
        || registration.context.summary?.kind !== 'session_turn') return
      const summary = registration.context.summary
      const role = t(summary.role === 'user'
        ? 'kubecode.priorUserTurn'
        : 'kubecode.priorAgentResponse')
      const name = t('kubecode.sessionTurnContextSummary', {
        role,
        lines: summary.line_count,
        bytes: summary.byte_count,
      })
      onApplyComposerCatalog(registration.catalog)
      updateComposerDraft((current) => appendComposerContext(
        current,
        createComposerContextReference({
          catalogRevision: registration.catalog.revision,
          id: registration.context.id,
          kind: 'session_turn',
          name,
          path: 'session-turn',
          summary,
        }),
      ))
      window.requestAnimationFrame(() => inputRef.current?.focus())
      trackEvent('kubecode_agent_context_inserted', {
        agent_id: conversation.agent_id,
        kind: 'session_turn',
      })
    }).catch((cause) => {
      if (request === menuContextRequestRef.current
        && activeConversationIdRef.current === targetConversationId) {
        reportError(cause)
      }
    }).finally(() => {
      if (request === menuContextRequestRef.current
        && activeConversationIdRef.current === targetConversationId) {
        setMenuContextPending(false)
      }
    })
  }

  const insertComposerCapability = (capability: RankedComposerCapability) => {
    if (!conversation || directTeammateChatDisabled || hardReadOnly || !capability.enabled) return
    const catalog = sessionState?.composer?.catalog
    if (!catalog
      || catalog.conversation_id !== conversation.id
      || catalog.revision !== capability.catalogRevision) return
    const current = catalog.items.find((item) => (
      item.id === capability.id && item.kind === capability.kind && item.enabled
    ))
    if (!current || current.kind === 'command') return
    updateComposerDraft((draft) => appendComposerCapability(
      draft,
      createComposerCapabilityReference({
        catalogRevision: catalog.revision,
        id: current.id,
        itemKind: capability.kind,
        name: current.name,
        scope: current.scope,
        sourceLabel: current.source_label,
      }),
    ))
    window.requestAnimationFrame(() => inputRef.current?.focus())
    trackEvent('kubecode_agent_context_inserted', {
      agent_id: conversation.agent_id,
      kind: current.kind,
    })
  }

  const dispatchCommand = async (command: AcpCommand, commandArguments: string) => {
    if (!conversation || !projectId || active || command.ambiguous
      || command.input.kind === 'unsupported') return
    onClearError()
    try {
      const nextRun = await api.dispatchAcpCommand(
        projectId,
        conversation.id,
        command.name,
        commandArguments,
      )
      attachRun(nextRun)
      updatePrompt('')
    } catch (cause) {
      reportError(cause)
    }
  }

  const send = async (text: string) => {
    const message = text.trim()
    if (!message
      || !conversation
      || !projectId
      || !agent?.available
      || active
      || composerSubmitDisabled
      || directTeammateChatDisabled
      || hardReadOnly) return
    const catalog = sessionState?.composer?.catalog
    if (composerHasTypedReferences && (!catalog || catalog.conversation_id !== conversation.id)) {
      return
    }
    const command = composerHasTypedReferences
      ? activeAcpCommand(composerDraftPlainText(composerDraft))
      : null
    const commandItems = command && catalog
      ? catalog.items.filter((item) => (
        item.kind === 'command' && item.enabled && item.name === command.name
      ))
      : []
    if (command && commandItems.length !== 1) return
    const draftSnapshot = composerDraft
    const clientMessageId = pendingRetryClientIdRef.current ?? newClientMessageId()
    pendingRetryClientIdRef.current = null
    appendOptimisticMessage(optimisticUserMessage(
      clientMessageId,
      composerDraftPlainText(composerDraft) || message,
    ))
    updatePrompt('')
    onClearError()
    try {
      let nextRun: AgentRun
      if (composerHasTypedReferences && catalog) {
        nextRun = await api.startStructuredRun(projectId, conversation.id, {
          ...(command ? { item_id: commandItems[0].id } : {}),
          catalog_revision: catalog.revision,
          segments: composerDraftToStructuredSegments(composerDraft, command?.name),
          client_message_id: clientMessageId,
        })
      } else {
        nextRun = await api.startRun(projectId, conversation.id, message, clientMessageId)
      }
      attachRun(nextRun)
      trackEvent('kubecode_agent_run_started', {
        agent_id: conversation.agent_id,
      })
    } catch (cause) {
      if (cause instanceof ApiError) {
        // The server saw and rejected the request: keep the bubble as a failed
        // turn (ADR 0210 §1 generation failure) instead of silently undoing it.
        failOptimisticMessage(clientMessageId)
        reportError(cause)
        return
      }
      // Ambiguous transport failure: the server may still have started the
      // run. Probe for the run by client message id before rolling back so a
      // late-arriving run is never double-executed by a manual resend.
      try {
        const runs = await api.listRuns(conversation.id)
        const started = runs.find((candidate) => candidate.client_message_id === clientMessageId)
        if (started) {
          attachRun(started)
          return
        }
      } catch {
        // The probe itself failed; fall through to the rollback below.
      }
      pendingRetryClientIdRef.current = clientMessageId
      removeOptimisticMessage(clientMessageId)
      updateComposerDraft((current) => (
        composerDraftPlainText(current) ? current : draftSnapshot
      ))
      reportError(cause)
    }
  }

  const sendSideQuestion = async (text: string) => {
    const question = sideQuestionText(text)
    if (!question
      || !conversation
      || !run
      || !canAskSideQuestion(conversation, sessionState, active)) return
    onClearError()
    try {
      const accepted = await api.askSideQuestion(conversation.id, question)
      setSideQuestions((current) => applySideQuestionEvent(current, 'side_question_started', {
        id: accepted.id,
        question,
        run_id: run.id,
      }))
      updatePrompt('')
    } catch (cause) {
      reportError(cause)
    }
  }

  return {
    activeCommand,
    capabilityLabels,
    composerContextPending,
    composerDraft,
    composerHasTypedReferences,
    composerSubmitDisabled,
    currentCommandIndex,
    gitDiffLabels,
    handleCommandKeyDown,
    inputRef,
    insertComposerCapability,
    insertComposerContext,
    insertComposerGitDiff,
    insertComposerSessionTurnContext,
    insertComposerTerminalContext,
    insertComposerText,
    prompt,
    send,
    sendSideQuestion,
    sessionTurnSources,
    setDismissedCommandPrompt,
    setInlineContextPending,
    setSelectedCommandIndex,
    updateComposerDraft,
    updatePrompt,
    visibleCommands,
  }
}
