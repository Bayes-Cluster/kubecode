import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  CaretLeft,
  CaretRight,
  DotsThree,
  Gear,
  LockKey,
  ListChecks,
  Plus,
  ArrowClockwise,
  ShieldWarning,
} from '@phosphor-icons/react'

import { AiAgentIcon } from '@/components/AiAgentIcon'
import { AiPanelComposer, AiPanelMessageHistory } from '@/components/AiPanelChrome'
import type { AiAction } from '@/components/AiMessage'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type { AiAgentMessage } from '@/lib/aiAgentConversation'
import type { AppLocale, TranslationKey, TranslationValues } from '@/lib/i18n'
import { trackEvent } from '@/lib/telemetry'

import {
  type AgentDescriptor,
  type AgentEvent,
  type AgentRun,
  type AgentSessionState,
  type ComposerCatalogSnapshot,
  type Conversation,
  type ConversationHistoryPage,
  type ConversationRevision,
  type Entry,
  type KubecodeApi,
  type SessionEvent,
  type TeamSnapshot,
  type WorkspaceEvent,
} from './api'
import { SystemMessageNotice } from './SystemMessageNotice'
import { ComposerAddMenu } from './ComposerAddMenu'
import type { ComposerCapabilityPickerLabels } from './ComposerCapabilityPicker'
import type { CommandPaletteSessionSnapshot, RankedCommandPaletteItem } from './commandPalette'
import { ComposerContextInput } from './ComposerContextInput'
import type { RankedComposerCapability } from './composerCapabilities'
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
} from './composerDraft'
import { AgentControlMenu } from './AgentControlMenu'
import { nativeSessionOptions } from './agentSessionOptions'
import { DeleteTeamDialog } from './DeleteTeamDialog'
import { SideQuestionPanel, type SideQuestionItem } from './SideQuestionPanel'
import { useSystemMessages } from './systemMessages'
import { TeamSessionOverview } from './TeamSessionOverview'
import { TeamWorkspaceView } from './TeamWorkspaceView'
import { AcpCommandMenu } from './AcpCommandMenu'
import {
  acpCommandCanDispatch,
  activeAcpCommand,
  availableAcpCommands,
  completeAcpCommand,
  matchingAcpCommands,
  type AcpCommand,
} from './acpCommands'

type Translator = (key: TranslationKey, values?: TranslationValues) => string
type PermissionChoice = { id: string; label: string; kind: string }
type PendingPermission = { requestId: string; tool: string; options: PermissionChoice[] }
type ElicitationAnswer = string | boolean
type ElicitationOption = { id: string; name: string }
type ElicitationProperty = {
  defaultValue: ElicitationAnswer
  description: string
  id: string
  label: string
  options: ElicitationOption[]
  required: boolean
  type: 'boolean' | 'integer' | 'number' | 'string'
}
type PendingElicitation = {
  message: string
  properties: ElicitationProperty[]
  requestId: string
}
export type SessionPlanEntry = {
  content: string
  priority: string
  status: 'completed' | 'in_progress' | 'pending'
}

type AgentSessionWorkspaceProps = {
  agents: AgentDescriptor[]
  agentsRefreshing?: boolean
  allowTeammateChat?: boolean
  api: KubecodeApi
  conversation: Conversation | null
  locale: AppLocale
  onConversationCreated: (conversation: Conversation) => void
  onConversationRemoved: (conversationId: string) => void
  onConversationUpdated: (conversation: Conversation) => void
  onAddProject?: () => void
  onCommandPaletteSessionChange?: (session: CommandPaletteSessionSnapshot | null) => void
  onNewSession?: () => void
  onOpenAgentSettings?: () => void
  onOpenPlan?: () => void
  onPlanChange?: (entries: SessionPlanEntry[]) => void
  onRefreshAgents?: () => Promise<void>
  onTeamCreated?: (team: TeamSnapshot) => void
  onTeamUpdated?: (team: TeamSnapshot) => void
  onSelectTeamMember?: (conversationId: string) => void
  projectId: string | null
  t: Translator
  workspaceEvents: WorkspaceEvent[]
  team?: TeamSnapshot | null
  titlebarTarget?: HTMLElement | null
}

const ACTIVE_RUN_STATUSES = new Set<AgentRun['status']>(['running', 'waiting_permission'])
const SESSION_STATE_EVENT_KINDS = new Set([
  'available_commands',
  'composer_catalog_snapshot',
  'config_options',
  'current_mode',
  'plan',
  'run_completed',
  'session_state',
  'session_info',
  'usage',
])
const SESSION_TIMELINE_EVENT_KINDS = new Set([
  'error',
  'run_completed',
  'text_delta',
  'thinking_delta',
  'tool_completed',
  'tool_started',
  'tool_updated',
  'user_message',
  'user_message_delta',
])
const SIDE_QUESTION_EVENT_KINDS = new Set([
  'side_question_completed',
  'side_question_failed',
  'side_question_started',
])
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

export function AgentSessionWorkspace({
  agents,
  agentsRefreshing = false,
  allowTeammateChat = false,
  api,
  conversation,
  locale,
  onConversationCreated,
  onConversationRemoved,
  onConversationUpdated,
  onAddProject,
  onCommandPaletteSessionChange,
  onNewSession,
  onOpenAgentSettings,
  onOpenPlan,
  onPlanChange,
  onRefreshAgents,
  onTeamCreated,
  onTeamUpdated,
  onSelectTeamMember,
  projectId,
  t,
  workspaceEvents,
  team,
  titlebarTarget,
}: AgentSessionWorkspaceProps) {
  const [composerDraft, setComposerDraft] = useState<ComposerDraft>(() => textComposerDraft())
  const [inlineContextPending, setInlineContextPending] = useState(false)
  const [menuContextPending, setMenuContextPending] = useState(false)
  const composerContextPending = inlineContextPending || menuContextPending
  const prompt = composerDraftPlainText(composerDraft)
  const [messages, setMessages] = useState<AiAgentMessage[]>([])
  const [run, setRun] = useState<AgentRun | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [workspaceWarning, setWorkspaceWarning] = useState<string | null>(null)
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null)
  const [pendingElicitation, setPendingElicitation] = useState<PendingElicitation | null>(null)
  const [elicitationAnswers, setElicitationAnswers] = useState<Record<string, ElicitationAnswer>>({})
  const [sessionState, setSessionState] = useState<AgentSessionState | null>(null)
  const [composerCatalogLoadFailed, setComposerCatalogLoadFailed] = useState(false)
  const [sideQuestions, setSideQuestions] = useState<SideQuestionItem[]>([])
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteTeamOpen, setDeleteTeamOpen] = useState(false)
  const [teamView, setTeamView] = useState<'chat' | 'team'>(
    conversation?.team_role === 'leader' ? 'team' : 'chat',
  )
  const [draftTitle, setDraftTitle] = useState('')
  const [revisions, setRevisions] = useState<ConversationRevision[]>([])
  const [viewRevisionId, setViewRevisionId] = useState<string | null>(null)
  const [historyCursor, setHistoryCursor] = useState<string | null>(null)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0)
  const [dismissedCommandPrompt, setDismissedCommandPrompt] = useState<string | null>(null)
  const systemMessages = useSystemMessages()
  const inputRef = useRef<HTMLDivElement>(null)
  const conversationDraftsRef = useRef(new Map<string, ComposerDraft>())
  const knownRunIdsRef = useRef(new Set<string>())
  const loadingRunsRef = useRef(new Map<string, Promise<AgentRun>>())
  const pendingRunEventsRef = useRef(new Map<string, AgentEvent[]>())
  const sessionStateRequestRef = useRef(0)
  const processedWorkspaceEventRef = useRef(workspaceEvents.at(-1)?.id ?? 0)
  const latestWorkspaceEventIdRef = useRef(workspaceEvents.at(-1)?.id ?? 0)
  latestWorkspaceEventIdRef.current = workspaceEvents.at(-1)?.id ?? 0
  const conversationId = conversation?.id ?? null
  const composerHasTypedReferences = composerDraftHasTypedReferences(composerDraft)
  const composerCatalogReady = !composerHasTypedReferences
    || sessionState?.composer?.catalog.conversation_id === conversationId
  const composerSubmitDisabled = composerContextPending
    || composerDraftHasStaleContext(composerDraft)
    || !composerCatalogReady
  const activeConversationIdRef = useRef(conversationId)
  activeConversationIdRef.current = conversationId
  const menuContextRequestRef = useRef(0)
  const agent = agents.find((item) => item.id === conversation?.agent_id)
  const agentLabel = conversation ? agentName(conversation.agent_id) : t('kubecode.agent')
  const active = Boolean(run && ACTIVE_RUN_STATUSES.has(run.status))
  const directTeammateChatDisabled = conversation?.team_role === 'teammate'
    && !allowTeammateChat
  const hardReadOnly = Boolean(
    conversation?.read_only || conversation?.team_role === 'discriminator',
  )
  const historyConversationId = viewRevisionId ?? conversation?.id ?? null
  const leaderReviewPending = conversation?.team_role === 'teammate'
    && run?.status === 'waiting_permission'
    && pendingPermission === null
  const waitingForInput = run?.status === 'waiting_permission'
    || pendingPermission !== null
    || pendingElicitation !== null
  const planEntries = useMemo(
    () => sessionPlanEntries(sessionState?.plan),
    [sessionState?.plan],
  )
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
  const reportError = useCallback((cause: unknown) => {
    const message = errorMessage(cause, t('kubecode.error'))
    if (systemMessages) {
      systemMessages.publish({ level: 'error', message, source: agentLabel })
    } else {
      setError(message)
    }
  }, [agentLabel, systemMessages, t])

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

  const applyComposerCatalog = useCallback((catalog: ComposerCatalogSnapshot) => {
    if (catalog.conversation_id !== conversationId) return
    setSessionState((current) => current ? { ...current, composer: { catalog } } : current)
  }, [conversationId])

  useEffect(() => {
    setComposerCatalogLoadFailed(false)
    if (!conversationId) {
      setComposerDraft(textComposerDraft())
      return
    }
    const persisted = readSessionDraft(conversationId)
    conversationDraftsRef.current.set(conversationId, persisted)
    setComposerDraft(persisted)
  }, [conversationId])

  useEffect(() => {
    menuContextRequestRef.current += 1
    setMenuContextPending(false)
  }, [conversationId])

  useEffect(() => {
    const catalog = sessionState?.composer?.catalog
    if (!catalog || catalog.conversation_id !== conversationId) return
    updateComposerDraft((current) => applyComposerCatalogSnapshot(current, catalog))
  }, [conversationId, sessionState?.composer?.catalog, updateComposerDraft])

  useEffect(() => {
    setTeamView(conversation?.team_role === 'leader' ? 'team' : 'chat')
  }, [conversation?.team_role, conversationId])

  useEffect(() => {
    onPlanChange?.(conversationId ? planEntries : [])
  }, [conversationId, onPlanChange, planEntries])

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
    void hydrateConversation(api, historyConversationId).then(({ messages: history, activeRun, pendingPermission: restoredPermission, pendingElicitation: restoredElicitation, sessionState: restoredState, sideQuestions: restoredSideQuestions, historyCursor: restoredCursor }) => {
      if (!current) return
      setMessages(history)
      knownRunIdsRef.current = new Set(history.flatMap((message) => message.id ? [message.id] : []))
      setRun(activeRun)
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
  }, [api, beginSessionStateRequest, conversation, historyConversationId, reportError])

  useEffect(() => {
    if (!conversation || viewRevisionId) return
    const nextEvents = workspaceEvents.filter((event) => (
      event.id > processedWorkspaceEventRef.current
        && event.conversation_id === conversation.id
    ))
    processedWorkspaceEventRef.current = workspaceEvents.at(-1)?.id
      ?? processedWorkspaceEventRef.current
    let refreshState = false
    for (const workspaceEvent of nextEvents) {
      refreshState ||= SESSION_STATE_EVENT_KINDS.has(workspaceEvent.kind)
      if (!workspaceEvent.run_id) continue
      const event: AgentEvent = {
        created_at: workspaceEvent.created_at,
        kind: workspaceEvent.kind,
        payload: workspaceEvent.payload,
        run_id: workspaceEvent.run_id as string,
        seq: workspaceEvent.id,
      }
      if (SIDE_QUESTION_EVENT_KINDS.has(event.kind)) {
        setSideQuestions((current) => applySideQuestionEvent(current, event.kind, event.payload))
        continue
      }
      if (event.kind === 'permission_requested') {
        const permission = permissionFromEvent(event)
        if (permission) setPendingPermission(permission)
      }
      if (event.kind === 'permission_resolved') setPendingPermission(null)
      if (event.kind === 'elicitation_requested') {
        const elicitation = elicitationFromEvent(event)
        if (elicitation) {
          setPendingElicitation(elicitation)
          setElicitationAnswers(initialElicitationAnswers(elicitation))
        }
      }
      if (event.kind === 'elicitation_resolved') setPendingElicitation(null)
      if (event.kind === 'run_started') {
        void loadRun(event.run_id)
      } else if (knownRunIdsRef.current.has(event.run_id)) {
        setMessages((current) => applyAgentEvent(current, event.run_id, event))
      } else {
        const pending = pendingRunEventsRef.current.get(event.run_id) ?? []
        pendingRunEventsRef.current.set(event.run_id, [...pending, event])
        void loadRun(event.run_id)
      }
      if (event.kind === 'run_completed') {
        void api.getRun(event.run_id).then(attachRun)
      }
    }
    if (refreshState) {
      const conversationId = conversation.id
      void requestSessionState(conversationId).catch(reportError)
    }
  }, [api, attachRun, conversation, loadRun, reportError, requestSessionState, viewRevisionId, workspaceEvents])

  const send = async (text: string) => {
    const message = text.trim()
    const typed = composerHasTypedReferences
    if (!message
      || !conversation
      || !projectId
      || !agent?.available
      || active
      || composerSubmitDisabled
      || directTeammateChatDisabled
      || hardReadOnly) return
    setError(null)
    try {
      let nextRun: AgentRun
      if (typed) {
        const catalog = sessionState?.composer?.catalog
        if (!catalog || catalog.conversation_id !== conversation.id) return
        const command = activeAcpCommand(composerDraftPlainText(composerDraft))
        const commandItems = command ? catalog.items.filter((item) => (
          item.kind === 'command' && item.enabled && item.name === command.name
        )) : []
        if (command && commandItems.length !== 1) return
        nextRun = await api.startStructuredRun(projectId, conversation.id, {
          ...(command ? { item_id: commandItems[0].id } : {}),
          catalog_revision: catalog.revision,
          segments: composerDraftToStructuredSegments(composerDraft, command?.name),
        })
      } else {
        nextRun = await api.startRun(projectId, conversation.id, message)
      }
      attachRun(nextRun)
      updatePrompt('')
      trackEvent('kubecode_agent_run_started', {
        agent_id: conversation.agent_id,
      })
    } catch (cause) {
      reportError(cause)
    }
  }

  const dispatchCommand = async (command: AcpCommand, commandArguments: string) => {
    if (!conversation || !projectId || active || command.ambiguous
      || command.input.kind === 'unsupported') return
    setError(null)
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

  const commandPaletteWritable = Boolean(
    conversation
      && projectId
      && agent?.available
      && !active
      && !directTeammateChatDisabled
      && !hardReadOnly
      && !viewRevisionId,
  )
  const commandPaletteCatalog = sessionState?.composer?.catalog.conversation_id === conversationId
    ? sessionState.composer.catalog
    : null
  const commandPaletteCatalogStatus = composerCatalogLoadFailed
    ? 'error' as const
    : conversation && !sessionState ? 'loading' as const : 'ready' as const
  const executeCommandPaletteItem = useCallback(async (
    selection: RankedCommandPaletteItem,
  ): Promise<boolean> => {
    if (!conversation
      || !projectId
      || !agent?.available
      || active
      || directTeammateChatDisabled
      || hardReadOnly
      || viewRevisionId) return false
    const catalog = sessionState?.composer?.catalog
    if (!catalog
      || catalog.conversation_id !== conversation.id
      || catalog.revision !== selection.catalogRevision) return false
    const current = catalog.items.find((item) => (
      item.id === selection.id && item.kind === selection.kind && item.enabled
    ))
    if (!current) return false
    try {
      const itemKind = current.kind
      if (itemKind === 'command') {
        const matchingCommands = availableAcpCommands(sessionState?.available_commands)
          .filter((command) => command.name === current.name)
        if (matchingCommands.length !== 1
          || matchingCommands[0].ambiguous
          || matchingCommands[0].input.kind === 'unsupported') return false
        if (matchingCommands[0].input.kind === 'text') {
          updatePrompt(`/${current.name} `)
        } else {
          attachRun(await api.dispatchComposerCommand(
            projectId,
            conversation.id,
            current.id,
            catalog.revision,
            '',
          ))
          updatePrompt('')
        }
      } else {
        updateComposerDraft((draft) => appendComposerCapability(
          draft,
          createComposerCapabilityReference({
            catalogRevision: catalog.revision,
            id: current.id,
            itemKind,
            name: current.name,
            scope: current.scope,
            sourceLabel: current.source_label,
          }),
        ))
      }
      window.requestAnimationFrame(() => inputRef.current?.focus())
      trackEvent('kubecode_command_palette_item_selected', {
        agent_id: conversation.agent_id,
        kind: itemKind,
      })
      return true
    } catch (cause) {
      reportError(cause)
      return false
    }
  }, [
    active,
    agent?.available,
    api,
    attachRun,
    conversation,
    directTeammateChatDisabled,
    hardReadOnly,
    projectId,
    reportError,
    sessionState?.available_commands,
    sessionState?.composer?.catalog,
    updateComposerDraft,
    updatePrompt,
    viewRevisionId,
  ])

  useEffect(() => {
    if (!onCommandPaletteSessionChange) return
    onCommandPaletteSessionChange({
      agentId: conversation?.agent_id ?? null,
      catalog: commandPaletteCatalog,
      catalogStatus: commandPaletteCatalogStatus,
      conversationId,
      execute: executeCommandPaletteItem,
      projectId,
      writable: commandPaletteWritable,
    })
    return () => onCommandPaletteSessionChange(null)
  }, [
    commandPaletteCatalog,
    commandPaletteCatalogStatus,
    commandPaletteWritable,
    conversation?.agent_id,
    conversationId,
    executeCommandPaletteItem,
    onCommandPaletteSessionChange,
    projectId,
  ])

  const sendSideQuestion = async (text: string) => {
    const question = sideQuestionText(text)
    if (!question || !conversation || !run || !canAskSideQuestion(conversation, sessionState, active)) {
      return
    }
    setError(null)
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

  const stop = async () => {
    if (run) await api.cancelRun(run.id)
  }

  const resolveElicitation = async (accepted: boolean) => {
    if (!pendingElicitation || !conversation) return
    const content = accepted
      ? elicitationContent(pendingElicitation, elicitationAnswers)
      : null
    await api.resolveElicitation(pendingElicitation.requestId, content)
    setPendingElicitation(null)
    trackEvent('kubecode_agent_elicitation_resolved', {
      accepted: accepted ? 1 : 0,
      agent_id: conversation.agent_id,
      field_count: pendingElicitation.properties.length,
    })
  }

  const rename = async () => {
    if (!conversation) return
    const updated = await api.updateConversation(conversation.id, draftTitle.trim() || null)
    onConversationUpdated(updated)
    setRenameOpen(false)
    trackEvent('kubecode_session_renamed', { agent_id: conversation.agent_id })
  }

  const restoreAgentTitle = async () => {
    if (!conversation) return
    onConversationUpdated(await api.updateConversation(conversation.id, null))
  }

  const deleteSession = async () => {
    if (!conversation) return
    try {
      await api.deleteConversation(conversation.id)
      const removedConversationIds = conversation.team_role === 'leader' && team
        ? team.members.map((member) => member.conversation_id)
        : [conversation.id]
      for (const conversationId of removedConversationIds) onConversationRemoved(conversationId)
      setDeleteTeamOpen(false)
      trackEvent('kubecode_session_deleted', {
        agent_id: conversation.agent_id,
        team_size: removedConversationIds.length,
      })
    } catch (cause) {
      reportError(cause)
    }
  }

  const requestDelete = () => {
    if (conversation?.team_role === 'leader'
      || team?.leader_conversation.id === conversation?.id) {
      setDeleteTeamOpen(true)
      return
    }
    void deleteSession()
  }

  const forkSession = async () => {
    if (!conversation) return
    const fork = await api.forkConversation(conversation.id)
    onConversationCreated(fork)
    trackEvent('kubecode_agent_session_forked', { agent_id: conversation.agent_id })
  }

  const reviseAtRun = async (runId: string, replacement?: string) => {
    if (!conversation
      || !projectId
      || active
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
  }

  const regenerate = async (runId: string) => {
    const message = messages.find((candidate) => candidate.id === runId)?.userMessage
    if (message) await reviseAtRun(runId, message)
  }

  const loadEarlierHistory = async () => {
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
  }

  const promoteToTeam = async () => {
    if (!conversation) return
    try {
      const team = await api.promoteToTeam(conversation.id, agentName(conversation.agent_id))
      onTeamCreated?.(team)
      trackEvent('kubecode_session_promoted_to_team', { leader_agent_id: conversation.agent_id })
    } catch (cause) {
      reportError(cause)
    }
  }

  if (!conversation) {
    const readyAgents = agents.filter((candidate) => candidate.available)
    return (
      <section className="kubecode-agent-session kubecode-session-empty" data-testid="agent-session-workspace">
        <img
          alt=""
          aria-hidden="true"
          className="kubecode-session-empty-mark"
          src={`${import.meta.env.BASE_URL}logo.svg`}
        />
        <h1>{projectId ? t('kubecode.startSession') : t('kubecode.firstRunTitle')}</h1>
        <p>{projectId ? t('kubecode.startSessionDescription') : t('kubecode.firstRunDescription')}</p>
        <div className="kubecode-agent-readiness-grid">
          {agents.map((candidate) => (
            <div
              className="kubecode-agent-readiness-card"
              data-ready={candidate.available}
              key={candidate.id}
            >
              <AiAgentIcon agent={candidate.id} size={22} />
              <span>
                <strong>{agentName(candidate.id)}</strong>
                <small>
                  {candidate.available
                    ? candidate.version ?? t('kubecode.ready')
                    : t('kubecode.unavailable')}
                </small>
              </span>
            </div>
          ))}
        </div>
        <div className="kubecode-session-empty-actions">
          {projectId ? (
            <Button
              aria-label={t('kubecode.startSession')}
              disabled={readyAgents.length === 0}
              onClick={onNewSession}
            >
              <Plus />
              {t('kubecode.newSession')}
            </Button>
          ) : (
            <Button aria-label={t('kubecode.firstRunTitle')} onClick={onAddProject}>
              <Plus />
              {t('kubecode.addProject')}
            </Button>
          )}
          <Button
            disabled={agentsRefreshing}
            variant="outline"
            onClick={() => void onRefreshAgents?.()}
          >
            <ArrowClockwise className={agentsRefreshing ? 'animate-spin' : undefined} />
            {t('kubecode.checkAgain')}
          </Button>
          <Button variant="ghost" onClick={onOpenAgentSettings}>
            <Gear />
            {t('kubecode.agentSettings')}
          </Button>
        </div>
        {projectId && readyAgents.length === 0 && (
          <span className="kubecode-session-empty-hint">{t('kubecode.noReadyAgents')}</span>
        )}
      </section>
    )
  }

  const readiness = agent?.available ? 'ready' : 'missing'
  const sideQuestionAvailable = canAskSideQuestion(conversation, sessionState, active)
  const commands = availableCommands(
    sessionState,
    sideQuestionAvailable ? t('kubecode.btwDescription') : null,
  )
  const openCodeCapabilityEmptyLabel = conversation.agent_id === 'opencode'
    && sessionState?.composer?.catalog
    && !sessionState.composer.catalog.items.some((item) => item.kind !== 'command')
    ? t('kubecode.noOpenCodeCapabilities')
    : undefined
  const capabilityStatus = composerCatalogLoadFailed
    ? 'error' as const
    : sessionState ? 'ready' as const : 'loading' as const
  const canFork = Boolean(
    conversation.provider_session_id && sessionCapability(sessionState, 'fork'),
  )
  const activeCommand = activeAcpCommand(prompt)
  const visibleCommands = !directTeammateChatDisabled
    && activeCommand
    && dismissedCommandPrompt !== prompt
    ? matchingAcpCommands(commands, activeCommand.name)
    : []
  const currentCommandIndex = visibleCommands.length === 0
    ? 0
    : Math.min(selectedCommandIndex, visibleCommands.length - 1)
  const { configs: configSelects, mode: nativeMode } = nativeSessionOptions(sessionState)
  const modeLockReason = nativeModeLockReason({
    active,
    agentId: conversation.agent_id,
    conversation,
    serverAccess: sessionState?.mode_access,
    team,
    viewRevisionId,
  })
  const completedPlanEntries = planEntries.filter((entry) => entry.status === 'completed').length

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
    if (directTeammateChatDisabled || hardReadOnly) return
    updateComposerDraft((current) => appendComposerText(current, text))
    window.requestAnimationFrame(() => inputRef.current?.focus())
    trackEvent('kubecode_agent_context_inserted', {
      agent_id: conversation.agent_id,
      kind,
    })
  }

  const insertComposerContext = (entry: Entry) => {
    if (directTeammateChatDisabled || hardReadOnly) return
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
      applyComposerCatalog(registration.catalog)
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

  const insertComposerCapability = (capability: RankedComposerCapability) => {
    if (directTeammateChatDisabled || hardReadOnly || !capability.enabled) return
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

  const commitSessionOption = async (
    optimisticState: AgentSessionState | null,
    request: () => Promise<void>,
  ) => {
    const confirmedState = sessionState
    const restoreConfirmedState = beginSessionStateRequest(conversation.id)
    setError(null)
    setSessionState(optimisticState)
    try {
      await request()
    } catch (cause) {
      restoreConfirmedState(confirmedState)
      reportError(cause)
      return
    }
    try {
      await requestSessionState(conversation.id)
    } catch (cause) {
      reportError(cause)
    }
  }

  const changeAgentConfig = (configId: string, value: string | boolean) => {
    trackEvent('kubecode_agent_setting_selected', {
      agent_id: conversation.agent_id,
      setting: configId,
    })
    void commitSessionOption(
      sessionStateWithConfig(sessionState, configId, value),
      () => api.setSessionConfig(conversation.id, configId, value),
    )
  }

  const changeNativeMode = (value: string) => {
    if (!nativeMode || modeLockReason) return
    trackEvent('kubecode_agent_setting_selected', {
      agent_id: conversation.agent_id,
      setting: 'mode',
    })
    if (nativeMode.kind === 'mode') {
      void commitSessionOption(
        sessionStateWithMode(sessionState, value),
        () => api.setSessionMode(conversation.id, value),
      )
      return
    }
    void commitSessionOption(
      sessionStateWithConfig(sessionState, nativeMode.id, value),
      () => api.setSessionConfig(conversation.id, nativeMode.id, value),
    )
  }

  const titlebar = (
    <div className="kubecode-session-titlebar-content">
      <div className="kubecode-session-title">
        <AiAgentIcon agent={conversation.agent_id} size={18} />
        <strong>{conversation.title || t('kubecode.untitledSession')}</strong>
      </div>
      {team && (
        <div className="kubecode-team-view-switch" role="tablist">
          <Button
            aria-selected={teamView === 'chat'}
            role="tab"
            size="xs"
            variant={teamView === 'chat' ? 'secondary' : 'ghost'}
            onClick={() => setTeamView('chat')}
          >
            {t('kubecode.chat')}
          </Button>
          <Button
            aria-selected={teamView === 'team'}
            role="tab"
            size="xs"
            variant={teamView === 'team' ? 'secondary' : 'ghost'}
            onClick={() => {
              setTeamView('team')
              trackEvent('kubecode_team_view_opened', { team_size: team.members.length })
            }}
          >
            {t('kubecode.teamSession')}
            {team.summary?.needs_attention > 0 && <span>{team.summary.needs_attention}</span>}
          </Button>
        </div>
      )}
      <div className="kubecode-session-status">
        <span data-state={waitingForInput ? 'stuck' : active ? 'running' : 'idle'} />
        <span className="kubecode-session-status-label">
          {waitingForInput
            ? t(pendingElicitation
              ? 'kubecode.answerAgentQuestion'
              : leaderReviewPending
                ? 'kubecode.waitingForLeaderPermission'
                : 'kubecode.permissionRequired')
            : active ? t('kubecode.running') : t('kubecode.ready')}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button aria-label={t('kubecode.sessionActions')} size="icon-xs" variant="ghost">
              <DotsThree />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => {
              setDraftTitle(conversation.manual_title ?? conversation.title)
              setRenameOpen(true)
            }}>
              {t('kubecode.renameSession')}
            </DropdownMenuItem>
            {conversation.manual_title && conversation.agent_title && (
              <DropdownMenuItem onSelect={() => void restoreAgentTitle()}>
                {t('kubecode.useAgentTitle')}
              </DropdownMenuItem>
            )}
            {canFork && (
              <DropdownMenuItem onSelect={() => void forkSession()}>
                {t('kubecode.forkSession')}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => void promoteToTeam()}>
              {t('kubecode.promoteToTeam')}
            </DropdownMenuItem>
            {conversation.team_role !== 'teammate'
              && conversation.team_role !== 'discriminator'
              && !team?.members.some((member) => (
                member.conversation_id === conversation.id && member.role !== 'leader'
              )) && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={requestDelete}>
                  {t('kubecode.delete')}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )

  return (
    <section
      className="kubecode-agent-session"
      data-team-view={team ? teamView : 'chat'}
      data-testid="agent-session-workspace"
    >
      {titlebarTarget ? createPortal(titlebar, titlebarTarget) : (
        <header className="kubecode-session-header">{titlebar}</header>
      )}
      {team && conversation && (
        <>
          {teamView === 'chat' && (
            <TeamSessionOverview
              activeConversationId={conversation.id}
              onSelectMember={onSelectTeamMember ?? (() => undefined)}
              snapshot={team}
            />
          )}
          {teamView === 'team' && (
            <TeamWorkspaceView
              api={api}
              onSelectMember={(conversationId) => {
                setTeamView('chat')
                onSelectTeamMember?.(conversationId)
              }}
              onSnapshotChange={onTeamUpdated ?? onTeamCreated ?? (() => undefined)}
              snapshot={team}
              t={t}
            />
          )}
        </>
      )}
      {(!team || teamView === 'chat') && (
        <>
        <div className="kubecode-session-timeline">
        <AiPanelMessageHistory
          agentLabel={agentLabel}
          agentReadiness={readiness}
          hasContext
          isActive={active}
          leadingContent={(
            <>
              {historyCursor && (
                <Button
                  className="kubecode-load-earlier"
                  disabled={loadingEarlier}
                  size="sm"
                  variant="ghost"
                  onClick={() => void loadEarlierHistory()}
                >
                  {loadingEarlier ? t('kubecode.loading') : t('kubecode.loadEarlierMessages')}
                </Button>
              )}
              {conversation.recreated_context && !viewRevisionId && (
                <div className="kubecode-recreated-context">{t('kubecode.recreatedContext')}</div>
              )}
              {revisions.length > 0 && (
                <RevisionNavigator
                  activeIndex={viewRevisionId
                    ? revisions.findIndex((revision) => (
                      revision.snapshot_conversation_id === viewRevisionId
                    ))
                    : revisions.length}
                  onSelect={(index) => {
                    setViewRevisionId(index === revisions.length
                      ? null
                      : revisions[index]?.snapshot_conversation_id ?? null)
                  }}
                  t={t}
                  total={revisions.length + 1}
                />
              )}
            </>
          )}
          locale={locale}
          messages={messages}
          onEditMessage={viewRevisionId || directTeammateChatDisabled || hardReadOnly
            ? undefined
            : (runId, userMessage) => void reviseAtRun(runId, userMessage)}
          onRegenerateMessage={viewRevisionId || directTeammateChatDisabled || hardReadOnly
            ? undefined
            : (runId) => void regenerate(runId)}
        />
      </div>
        <div className="kubecode-session-composer-dock">
      <SideQuestionPanel items={sideQuestions} t={t} />
      {error && (
        <SystemMessageNotice
          detailsLabel={t('kubecode.details')}
          dismissLabel={t('window.close')}
          level="error"
          message={error}
          onDismiss={() => setError(null)}
        />
      )}
      {workspaceWarning && (
        <SystemMessageNotice
          detailsLabel={t('kubecode.details')}
          dismissLabel={t('window.close')}
          level="warning"
          message={workspaceWarning}
          onDismiss={() => setWorkspaceWarning(null)}
        />
      )}
      {pendingPermission && (
        <div aria-live="polite" className="kubecode-permission-dock">
          <div className="kubecode-permission-heading">
            <ShieldWarning size={17} />
            <strong>{t('kubecode.permissionRequired')}</strong>
          </div>
          <code className="kubecode-permission-command">{pendingPermission.tool}</code>
          <div className="kubecode-permission-actions">
            {pendingPermission.options.map((option) => (
              <Button
                key={option.id}
                size="sm"
                title={option.label}
                variant={option.kind.startsWith('reject') ? 'outline' : 'default'}
                onClick={() => void api.resolvePermission(pendingPermission.requestId, option.id)}
              >
                {permissionChoiceLabel(option, t)}
              </Button>
            ))}
          </div>
        </div>
      )}
      {leaderReviewPending && (
        <div aria-live="polite" className="kubecode-permission-dock kubecode-permission-leader-review">
          <div className="kubecode-permission-heading">
            <ShieldWarning size={17} />
            <strong>{t('kubecode.waitingForLeaderPermission')}</strong>
          </div>
        </div>
      )}
      {pendingElicitation && (
        <div className="kubecode-elicitation-dock">
          <div className="kubecode-elicitation-heading">
            <strong>{t('kubecode.answerAgentQuestion')}</strong>
            <span>{pendingElicitation.message}</span>
          </div>
          <div className="kubecode-elicitation-fields">
            {pendingElicitation.properties.map((property) => (
              <label key={property.id} className="kubecode-elicitation-field">
                <span>{property.label}{property.required ? ' *' : ''}</span>
                {property.description && <small>{property.description}</small>}
                {property.type === 'boolean' ? (
                  <Switch
                    aria-label={property.label}
                    checked={Boolean(elicitationAnswers[property.id])}
                    onCheckedChange={(value) => setElicitationAnswers((current) => ({
                      ...current,
                      [property.id]: value,
                    }))}
                  />
                ) : property.options.length > 0 ? (
                  <Select
                    value={String(elicitationAnswers[property.id] ?? '')}
                    onValueChange={(value) => setElicitationAnswers((current) => ({
                      ...current,
                      [property.id]: value,
                    }))}
                  >
                    <SelectTrigger aria-label={property.label}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {property.options.map((option) => (
                        <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    aria-label={property.label}
                    type={property.type === 'string' ? 'text' : 'number'}
                    value={String(elicitationAnswers[property.id] ?? '')}
                    onChange={(event) => setElicitationAnswers((current) => ({
                      ...current,
                      [property.id]: event.target.value,
                    }))}
                  />
                )}
              </label>
            ))}
          </div>
          <div className="kubecode-elicitation-actions">
            <Button size="sm" variant="outline" onClick={() => void resolveElicitation(false)}>
              {t('kubecode.decline')}
            </Button>
            <Button
              disabled={!elicitationComplete(pendingElicitation, elicitationAnswers)}
              size="sm"
              onClick={() => void resolveElicitation(true)}
            >
              {t('kubecode.submitAnswers')}
            </Button>
          </div>
        </div>
      )}
      {planEntries.length > 0 && (
        <div className="kubecode-session-plan">
          <Button
            aria-label={t('kubecode.showAgentPlan')}
            className="kubecode-session-plan-trigger"
            size="sm"
            variant="ghost"
            onClick={onOpenPlan}
          >
            <ListChecks />
            <span>{t('kubecode.agentPlan')}</span>
            <span>{completedPlanEntries} / {planEntries.length}</span>
            <CaretRight />
          </Button>
        </div>
      )}
      <div className="kubecode-session-composer">
        {hardReadOnly || viewRevisionId ? (
          <div className="kubecode-read-only-session">
            <LockKey />
            <span>{viewRevisionId
              ? t('kubecode.revisionReadOnly')
              : t('kubecode.readOnlySubagent')}</span>
          </div>
        ) : (
          <>
            {!directTeammateChatDisabled
              && run
              && ['cancelled', 'failed', 'interrupted'].includes(run.status) && (
              <Button className="kubecode-undo-turn" size="sm" variant="ghost" onClick={() => void reviseAtRun(run.id)}>
                {t('kubecode.undoTurn')}
              </Button>
            )}
            {visibleCommands.length > 0 && (
              <AcpCommandMenu
                commands={visibleCommands}
                label={t('command.palettePlaceholder')}
                onHover={setSelectedCommandIndex}
                onSelect={(command) => {
                  updatePrompt(completeAcpCommand(command))
                  window.requestAnimationFrame(() => inputRef.current?.focus())
                }}
                selectedIndex={currentCommandIndex}
                unavailableLabel={t('kubecode.unavailable')}
              />
            )}
            <AiPanelComposer
              agentLabel={agentLabel}
              agentReadiness={readiness}
              disabled={directTeammateChatDisabled}
              disabledPlaceholder={t('kubecode.teammateChatDisabled')}
              leadingControl={projectId && !directTeammateChatDisabled ? (
                <ComposerAddMenu
                  api={api}
                  capabilityCatalog={sessionState?.composer?.catalog}
                  capabilityEmptyLabel={openCodeCapabilityEmptyLabel}
                  capabilityLabels={capabilityLabels}
                  capabilityStatus={capabilityStatus}
                  commands={commands}
                  conversationId={conversation.id}
                  onCapability={insertComposerCapability}
                  onInsert={insertComposerText}
                  onReference={insertComposerContext}
                  projectId={projectId}
                  t={t}
                />
              ) : undefined}
              controls={nativeMode || configSelects.length > 0 ? (
                <AgentControlMenu
                  agent={conversation.agent_id}
                  configs={configSelects}
                  mode={nativeMode}
                  modeDisabled={Boolean(modeLockReason)}
                  modeDisabledReason={modeLockReason ? nativeModeLockMessage(modeLockReason, t) : undefined}
                  onConfigChange={changeAgentConfig}
                  onModeChange={changeNativeMode}
                  t={t}
                />
              ) : undefined}
              entries={[]}
              input={prompt}
              inputContent={(
                <ComposerContextInput
                  api={api}
                  capabilityCatalog={sessionState?.composer?.catalog}
                  capabilityLabels={capabilityLabels}
                  capabilityStatus={capabilityStatus}
                  contextEmptyLabel={t('kubecode.noContextFound')}
                  contextErrorLabel={t('kubecode.contextLoadFailed')}
                  contextLoadingLabel={t('kubecode.loadingContext')}
                  contextPickerLabel={t('kubecode.addContext')}
                  contextRemoveLabel={t('kubecode.removeContext')}
                  conversationId={conversation.id}
                  disabled={directTeammateChatDisabled || readiness !== 'ready'}
                  draft={composerDraft}
                  inputRef={inputRef}
                  onChange={updateComposerDraft}
                  onCatalogChange={applyComposerCatalog}
                  onKeyDownCapture={handleCommandKeyDown}
                  onPendingChange={setInlineContextPending}
                  onRegistrationError={reportError}
                  onSubmit={(text) => {
                    if (composerSubmitDisabled) return
                    if (active) {
                      if (!composerDraftHasTypedReferences(composerDraft)
                        && sideQuestionAvailable && sideQuestionText(text)) {
                        void sendSideQuestion(text)
                      }
                    } else {
                      void send(text)
                    }
                  }}
                  placeholder={directTeammateChatDisabled
                    ? t('kubecode.teammateChatDisabled')
                    : readiness === 'missing'
                      ? t('ai.panel.placeholder.missing', { agent: agentLabel })
                      : t('ai.panel.placeholder.ready', { agent: agentLabel })}
                  submitDisabled={composerSubmitDisabled}
                />
              )}
              inputRef={inputRef}
              isActive={active}
              locale={locale}
              onChange={updatePrompt}
              activeSendLabel={t('kubecode.askSideQuestion')}
              onActiveSend={sideQuestionAvailable && sideQuestionText(prompt)
                ? (text) => void sendSideQuestion(text)
                : undefined}
              onSend={(text) => void send(text)}
              onStop={() => void stop()}
              sendDisabled={composerSubmitDisabled}
              statusMessage={composerDraftHasStaleContext(composerDraft)
                ? t('kubecode.staleContext')
                : undefined}
            />
          </>
          )}
        </div>
        </div>
        </>
      )}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('kubecode.renameSession')}</DialogTitle>
            <DialogDescription>{t('kubecode.renameSessionDescription')}</DialogDescription>
          </DialogHeader>
          <Input
            aria-label={t('kubecode.sessionTitle')}
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void rename()
            }}
          />
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">{t('kubecode.cancel')}</Button></DialogClose>
            <Button onClick={() => void rename()}>{t('kubecode.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DeleteTeamDialog
        onConfirm={deleteSession}
        onOpenChange={setDeleteTeamOpen}
        open={deleteTeamOpen}
        t={t}
        teamName={team?.team.title.trim() || conversation.title || t('kubecode.teamSession')}
        teammateCount={team
          ? team.members.filter((member) => member.role === 'teammate').length
          : 0}
      />
    </section>
  )
}

function RevisionNavigator({
  activeIndex,
  onSelect,
  t,
  total,
}: {
  activeIndex: number
  onSelect: (index: number) => void
  t: Translator
  total: number
}) {
  return (
    <div className="kubecode-revision-navigator">
      <Button
        aria-label={t('kubecode.previousRevision')}
        disabled={activeIndex <= 0}
        size="icon-xs"
        variant="ghost"
        onClick={() => onSelect(activeIndex - 1)}
      >
        <CaretLeft />
      </Button>
      <span>{t('kubecode.revisionPosition', {
        current: activeIndex + 1,
        total,
      })}</span>
      <Button
        aria-label={t('kubecode.nextRevision')}
        disabled={activeIndex >= total - 1}
        size="icon-xs"
        variant="ghost"
        onClick={() => onSelect(activeIndex + 1)}
      >
        <CaretRight />
      </Button>
    </div>
  )
}

async function hydrateConversation(
  api: KubecodeApi,
  conversationId: string,
): Promise<{
  messages: AiAgentMessage[]
  activeRun: AgentRun | null
  pendingPermission: PendingPermission | null
  pendingElicitation: PendingElicitation | null
  sessionState: AgentSessionState
  sideQuestions: SideQuestionItem[]
  historyCursor: string | null
}> {
  if (typeof api.getConversationHistory === 'function') {
    const [page, sessionState] = await Promise.all([
      api.getConversationHistory(conversationId),
      api.getSessionState(conversationId),
    ])
    const events = page.runs.map((run) => page.events[run.id] ?? [])
    const activeRun = [...page.runs]
      .reverse()
      .find((item) => ACTIVE_RUN_STATUSES.has(item.status)) ?? null
    const activeRunIndex = activeRun
      ? page.runs.findIndex((item) => item.id === activeRun.id)
      : -1
    return {
      messages: messagesFromHistoryPage(page),
      activeRun: page.runs.at(-1) ?? null,
      pendingPermission: activeRunIndex >= 0
        ? pendingPermissionFromEvents(events[activeRunIndex])
        : null,
      pendingElicitation: activeRunIndex >= 0
        ? pendingElicitationFromEvents(events[activeRunIndex])
        : null,
      sessionState,
      sideQuestions: sideQuestionsFromSessionEvents(page.session_events),
      historyCursor: page.next_cursor,
    }
  }
  const [runs, sessionEvents, sessionState] = await Promise.all([
    api.listRuns(conversationId),
    api.listSessionEvents(conversationId),
    api.getSessionState(conversationId),
  ])
  const events = await Promise.all(runs.map((run) => api.listEvents(run.id)))
  const messages = sessionEvents.length > 0
    ? messagesFromSessionEvents(sessionEvents, runs)
    : runs.map((run, index) => (
        events[index].reduce(
          (history, event) => applyAgentEvent(history, run.id, event),
          [messageFromRun(run)],
        )[0]
      ))
  const activeRun = [...runs].reverse().find((item) => ACTIVE_RUN_STATUSES.has(item.status)) ?? null
  const activeRunIndex = activeRun ? runs.findIndex((item) => item.id === activeRun.id) : -1
  const pendingPermission = activeRunIndex >= 0
    ? pendingPermissionFromEvents(events[activeRunIndex])
    : null
  const pendingElicitation = activeRunIndex >= 0
    ? pendingElicitationFromEvents(events[activeRunIndex])
    : null
  return {
    messages,
    activeRun: runs.at(-1) ?? null,
    pendingPermission,
    pendingElicitation,
    sessionState,
    sideQuestions: sideQuestionsFromSessionEvents(sessionEvents),
    historyCursor: null,
  }
}

function messagesFromHistoryPage(page: ConversationHistoryPage): AiAgentMessage[] {
  if (page.session_events.length > 0) {
    return messagesFromSessionEvents(page.session_events, page.runs)
  }
  return page.runs.map((run) => (
    (page.events[run.id] ?? []).reduce(
      (history, event) => applyAgentEvent(history, run.id, event),
      [messageFromRun(run)],
    )[0]
  ))
}

function messagesFromSessionEvents(events: SessionEvent[], runs: AgentRun[]): AiAgentMessage[] {
  const runById = new Map(runs.map((run) => [run.id, run]))
  return events.reduce<AiAgentMessage[]>((messages, event) => {
    if (!SESSION_TIMELINE_EVENT_KINDS.has(event.kind)) return messages
    const runId = textValue(event.payload.run_id)
    if (event.kind === 'user_message') {
      const run = runById.get(runId)
      if (run?.internal || event.payload.internal === true) {
        return [...messages, {
          ...(run ? messageFromRun(run) : nativeMessage(event, '')),
          internal: true,
          userMessage: '',
        }]
      }
      return [...messages, run ? messageFromRun(run) : nativeMessage(event, textValue(event.payload.text))]
    }
    if (event.kind === 'user_message_delta') {
      const last = messages.at(-1)
      const text = textValue(event.payload.text)
      if (last?.id?.startsWith('native-') && !last.response && !last.reasoning) {
        return [...messages.slice(0, -1), { ...last, userMessage: `${last.userMessage ?? ''}${text}` }]
      }
      return [...messages, nativeMessage(event, text)]
    }
    if (!runId && messages.length === 0) return messages
    if (event.kind === 'run_completed' && messages.length === 0) return messages
    const message = messages.at(-1) ?? nativeMessage(event, '')
    const messageId = message.id ?? `native-${event.seq}`
    const history = messages.length > 0 ? messages : [message]
    const mapped: AgentEvent = {
      created_at: event.created_at,
      kind: event.kind,
      payload: event.payload,
      run_id: messageId,
      seq: event.seq,
    }
    return applyAgentEvent(history, messageId, mapped)
  }, [])
}

function permissionChoiceLabel(option: PermissionChoice, t: Translator): string {
  if (option.kind === 'allow_always') return t('kubecode.allowAll')
  if (option.kind === 'allow_once') return t('kubecode.allow')
  if (option.kind === 'reject_once' || option.kind === 'reject_always') {
    return t('kubecode.reject')
  }
  return option.label
}

function nativeMessage(event: SessionEvent, text: string): AiAgentMessage {
  return {
    actions: [],
    id: `native-${event.seq}`,
    isStreaming: false,
    reasoningDone: true,
    userMessage: text,
  }
}

function availableCommands(
  state: AgentSessionState | null,
  sideQuestionDescription: string | null = null,
): AcpCommand[] {
  const commands = availableAcpCommands(state?.available_commands)
  if (sideQuestionDescription) {
    return [{
      name: 'btw',
      description: sideQuestionDescription,
      input: { kind: 'text', hint: sideQuestionDescription },
      providerIndex: -1,
      ambiguous: false,
      privateSideQuestion: true,
    }, ...commands.filter((command) => command.name !== 'btw')]
  }
  return commands
}

function capabilityDisabledReason(reason: string | null, t: Translator): string {
  if (reason === 'ambiguous_source_identity') return t('kubecode.capabilityDisabledAmbiguous')
  if (reason === 'unsupported_input' || reason === 'unsupported_invocation') {
    return t('kubecode.capabilityDisabledUnsupported')
  }
  return t('kubecode.capabilityDisabledUnavailable')
}

function canAskSideQuestion(
  conversation: Conversation,
  state: AgentSessionState | null,
  active: boolean,
): boolean {
  if (!active || conversation.agent_id !== 'claude_code') return false
  const meta = objectValue(state?.capabilities?._meta)
  const claudeCode = objectValue(meta?.claudeCode)
  return claudeCode?.sideQuestion === true
}

function sideQuestionText(value: string): string | null {
  const match = value.trim().match(/^\/btw(?:\s+)([\s\S]+)$/)
  return match?.[1]?.trim() || null
}

function sideQuestionsFromSessionEvents(events: SessionEvent[]): SideQuestionItem[] {
  return events.reduce((items, event) => (
    SIDE_QUESTION_EVENT_KINDS.has(event.kind)
      ? applySideQuestionEvent(items, event.kind, event.payload)
      : items
  ), [] as SideQuestionItem[])
}

function applySideQuestionEvent(
  items: SideQuestionItem[],
  kind: string,
  payload: Record<string, unknown>,
): SideQuestionItem[] {
  const id = textValue(payload.id)
  if (!id) return items
  const existing = items.find((item) => item.id === id)
  const next: SideQuestionItem = {
    id,
    question: textValue(payload.question) || existing?.question || '',
    runId: textValue(payload.run_id) || existing?.runId || '',
    status: kind === 'side_question_completed'
      ? 'completed'
      : kind === 'side_question_failed' ? 'failed' : 'pending',
    answer: kind === 'side_question_completed'
      ? textValue(payload.answer)
      : existing?.answer,
    error: kind === 'side_question_failed'
      ? textValue(payload.message)
      : existing?.error,
  }
  return existing
    ? items.map((item) => item.id === id ? next : item)
    : [...items, next]
}

function sessionCapability(state: AgentSessionState | null, capability: string): boolean {
  const sessionCapabilities = state?.capabilities?.sessionCapabilities
  if (!sessionCapabilities || typeof sessionCapabilities !== 'object') return false
  return (sessionCapabilities as Record<string, unknown>)[capability] != null
}

function sessionStateWithMode(
  state: AgentSessionState | null,
  currentModeId: string,
): AgentSessionState | null {
  if (!state?.current_mode) return state
  return {
    ...state,
    current_mode: { ...state.current_mode, currentModeId },
  }
}

function sessionStateWithConfig(
  state: AgentSessionState | null,
  configId: string,
  currentValue: string | boolean,
): AgentSessionState | null {
  const configOptions = state?.config_options?.configOptions
  if (!state?.config_options || !Array.isArray(configOptions)) return state
  return {
    ...state,
    config_options: {
      ...state.config_options,
      configOptions: configOptions.map((value) => {
        const config = objectValue(value)
        return textValue(config?.id) === configId ? { ...config, currentValue } : value
      }),
    },
  }
}

function sessionPlanEntries(plan: Record<string, unknown> | null | undefined): SessionPlanEntry[] {
  if (!plan) return []
  const nestedPlan = objectValue(plan.plan)
  const values = arrayValue(plan.entries)
    ?? arrayValue(nestedPlan?.entries)
    ?? arrayValue(objectValue(plan.items)?.entries)
  if (!values) return []
  return values.flatMap((value) => {
    const entry = objectValue(value)
    const content = textValue(entry?.content)
    if (!content) return []
    return [{
      content,
      priority: textValue(entry?.priority) || 'medium',
      status: planEntryStatus(textValue(entry?.status)),
    }]
  })
}

function planEntryStatus(status: string): SessionPlanEntry['status'] {
  if (status === 'completed') return 'completed'
  if (status === 'in_progress' || status === 'inProgress') return 'in_progress'
  return 'pending'
}

function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null
}


function nativeModeLockReason({
  active,
  agentId,
  conversation,
  serverAccess,
  team,
  viewRevisionId,
}: {
  active: boolean
  agentId: Conversation['agent_id']
  conversation: Conversation
  serverAccess: AgentSessionState['mode_access']
  team?: TeamSnapshot | null
  viewRevisionId: string | null
}): NonNullable<AgentSessionState['mode_access']>['reason'] {
  if (viewRevisionId || conversation.read_only) return 'read_only'
  if (conversation.team_role === 'discriminator') return 'team_discriminator'
  if (conversation.team_role === 'teammate') return 'team_teammate'
  if (team?.team.mode === 'yolo' && agentId !== 'opencode') return 'team_yolo_permission'
  if (active) return 'active_run'
  return serverAccess?.can_change === false ? serverAccess.reason : null
}

function nativeModeLockMessage(
  reason: NonNullable<AgentSessionState['mode_access']>['reason'],
  t: Translator,
): string {
  const keys = {
    active_run: 'kubecode.running',
    read_only: 'kubecode.readOnlySubagent',
    team_discriminator: 'kubecode.readOnlySubagent',
    team_teammate: 'kubecode.teamLeader',
    team_yolo_permission: 'kubecode.teamYoloNativePermission',
  } as const satisfies Record<NonNullable<typeof reason>, TranslationKey>
  return reason ? t(keys[reason]) : ''
}

function pendingPermissionFromEvents(events: AgentEvent[]): PendingPermission | null {
  return events.reduce<PendingPermission | null>((pending, event) => {
    if (event.kind === 'permission_requested') return permissionFromEvent(event) ?? pending
    if (event.kind !== 'permission_resolved') return pending
    const requestId = textValue(event.payload.request_id)
    return !requestId || pending?.requestId === requestId ? null : pending
  }, null)
}

function pendingElicitationFromEvents(events: AgentEvent[]): PendingElicitation | null {
  return events.reduce<PendingElicitation | null>((pending, event) => {
    if (event.kind === 'elicitation_requested') return elicitationFromEvent(event) ?? pending
    if (event.kind !== 'elicitation_resolved') return pending
    const requestId = textValue(event.payload.request_id)
    return !requestId || pending?.requestId === requestId ? null : pending
  }, null)
}

function elicitationFromEvent(event: AgentEvent): PendingElicitation | null {
  const requestId = textValue(event.payload.request_id)
  const message = textValue(event.payload.message)
  const schema = objectValue(event.payload.requestedSchema)
  const values = objectValue(schema?.properties)
  if (!requestId || !message || !values) return null
  const required = new Set(Array.isArray(schema?.required) ? schema.required.filter(isString) : [])
  const properties = Object.entries(values).flatMap(([id, value]) => {
    const property = objectValue(value)
    const type = propertyType(property?.type)
    if (!property || !type) return []
    return [{
      defaultValue: propertyDefault(property, type),
      description: textValue(property.description),
      id,
      label: textValue(property.title) || id,
      options: propertyOptions(property),
      required: required.has(id),
      type,
    }]
  })
  return { message, properties, requestId }
}

function initialElicitationAnswers(elicitation: PendingElicitation | null): Record<string, ElicitationAnswer> {
  return Object.fromEntries(elicitation?.properties.map((property) => [property.id, property.defaultValue]) ?? [])
}

function elicitationComplete(
  elicitation: PendingElicitation,
  answers: Record<string, ElicitationAnswer>,
): boolean {
  return elicitation.properties.every((property) => (
    !property.required || property.type === 'boolean' || String(answers[property.id] ?? '').trim().length > 0
  ))
}

function elicitationContent(
  elicitation: PendingElicitation,
  answers: Record<string, ElicitationAnswer>,
): Record<string, string | number | boolean | string[]> {
  const content: Record<string, string | number | boolean | string[]> = {}
  for (const property of elicitation.properties) {
    const value = answers[property.id] ?? property.defaultValue
    if (!property.required && property.type !== 'boolean' && String(value).trim() === '') continue
    if (property.type === 'integer') content[property.id] = Number.parseInt(String(value), 10)
    else if (property.type === 'number') content[property.id] = Number.parseFloat(String(value))
    else content[property.id] = value
  }
  return content
}

function propertyType(value: unknown): ElicitationProperty['type'] | null {
  return value === 'boolean' || value === 'integer' || value === 'number' || value === 'string'
    ? value
    : null
}

function propertyDefault(
  property: Record<string, unknown>,
  type: ElicitationProperty['type'],
): ElicitationAnswer {
  if (type === 'boolean') return typeof property.default === 'boolean' ? property.default : false
  if (typeof property.default === 'string' || typeof property.default === 'number') {
    return String(property.default)
  }
  return propertyOptions(property)[0]?.id ?? ''
}

function propertyOptions(property: Record<string, unknown>): ElicitationOption[] {
  if (Array.isArray(property.oneOf)) {
    return property.oneOf.flatMap((value) => {
      const option = objectValue(value)
      const id = textValue(option?.const)
      if (!id) return []
      return [{ id, name: textValue(option?.title) || id }]
    })
  }
  return Array.isArray(property.enum)
    ? property.enum.filter(isString).map((id) => ({ id, name: id }))
    : []
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function messageFromRun(run: AgentRun): AiAgentMessage {
  return {
    actions: [],
    id: run.id,
    isStreaming: ACTIVE_RUN_STATUSES.has(run.status),
    reasoningDone: !ACTIVE_RUN_STATUSES.has(run.status),
    userMessage: run.message,
    internal: Boolean(run.internal),
  }
}

function applyAgentEvent(
  messages: AiAgentMessage[],
  runId: string,
  event: AgentEvent,
): AiAgentMessage[] {
  return messages.map((message) => {
    if (message.id !== runId) return message
    if (event.kind === 'text_delta') {
      return appendResponseBlock(message, event.payload, event.seq)
    }
    if (event.kind === 'thinking_delta') {
      return { ...message, reasoning: `${message.reasoning ?? ''}${textValue(event.payload.text)}` }
    }
    if (event.kind === 'tool_started' || event.kind === 'tool_updated') {
      return { ...message, actions: upsertAction(message.actions, event, 'pending') }
    }
    if (event.kind === 'tool_completed') {
      return { ...message, actions: upsertAction(message.actions, event, 'done') }
    }
    if (event.kind === 'error') {
      const failed = {
        ...message,
        isStreaming: false,
        reasoningDone: true,
      }
      return message.responseBlocks?.length
        ? appendResponseBlock(failed, {
            message_id: `error-${event.seq}`,
            text: textValue(event.payload.message),
          }, event.seq)
        : { ...failed, response: `${message.response ?? ''}${textValue(event.payload.message)}` }
    }
    if (event.kind === 'run_completed') {
      return { ...message, isStreaming: false, reasoningDone: true }
    }
    return message
  })
}

function appendResponseBlock(
  message: AiAgentMessage,
  payload: Record<string, unknown>,
  sequence: number,
): AiAgentMessage {
  const text = textValue(payload.text)
  const nativeMessageId = textValue(payload.message_id)
  if (!nativeMessageId) {
    return { ...message, response: `${message.response ?? ''}${text}` }
  }
  const blocks = message.responseBlocks
    ? [...message.responseBlocks]
    : message.response ? [{ id: `legacy-${sequence}`, text: message.response }] : []
  const last = blocks.at(-1)
  if (last?.id === nativeMessageId) {
    blocks[blocks.length - 1] = { ...last, text: `${last.text}${text}` }
  } else {
    blocks.push({ id: nativeMessageId, text })
  }
  return { ...message, response: undefined, responseBlocks: blocks }
}

function upsertAction(
  actions: AiAction[],
  event: AgentEvent,
  status: AiAction['status'],
): AiAction[] {
  const toolId = textValue(event.payload.tool_id) || `tool-${event.seq}`
  const tool = textValue(event.payload.tool) || 'Tool'
  const existing = actions.find((action) => action.toolId === toolId)
  const action: AiAction = {
    input: displayValue(event.payload.input) || existing?.input,
    label: tool,
    output: displayValue(event.payload.output) || displayValue(event.payload.content) || existing?.output,
    status,
    tool,
    toolId,
  }
  return existing
    ? actions.map((current) => current.toolId === toolId ? action : current)
    : [...actions, action]
}

function displayValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function permissionFromEvent(event: AgentEvent): PendingPermission | null {
  const requestId = textValue(event.payload.request_id)
  if (textValue(event.payload.reviewer) === 'leader') return null
  if (!requestId || !Array.isArray(event.payload.options)) return null
  const options = event.payload.options.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const option = value as Record<string, unknown>
    const id = textValue(option.id)
    const label = textValue(option.label)
    if (!id || !label) return []
    return [{ id, label, kind: textValue(option.kind) }]
  })
  return { requestId, tool: textValue(event.payload.tool) || 'Tool', options }
}

function agentName(id: Conversation['agent_id']): string {
  if (id === 'claude_code') return 'Claude Code'
  if (id === 'opencode') return 'OpenCode'
  return 'Codex'
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}
