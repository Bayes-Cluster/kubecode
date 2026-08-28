import type { AiAgentMessage } from '@/lib/aiAgentConversation'
import type { TranslationKey, Translator } from '@/lib/i18n'

import type { AcpCommand } from '../acpCommands'
import { availableAcpCommands } from '../acpCommands'
import type { SideQuestionItem } from '../SideQuestionPanel'
import type {
  AgentEvent,
  AgentRun,
  AgentSessionState,
  Conversation,
  ConversationHistoryPage,
  KubecodeApi,
  SessionEvent,
  TeamSnapshot,
} from '../api'
import type {
  ConversationState,
  ElicitationAnswer,
  PendingElicitation,
  PendingPermission,
  TerminalCause,
} from './conversationReducer'
import {
  applySideQuestionEvent,
  arrayValue,
  elicitationFromEvent,
  initialConversationState,
  objectValue,
  permissionFromEvent,
  reduceAll,
  reduceConversation,
  SIDE_QUESTION_EVENT_KINDS,
  textValue,
} from './conversationReducer'

// ---------------------------------------------------------------------------
// Pure conversation plumbing lives in conversationReducer.ts (#103); this
// module re-exports it so existing callers keep their import surface.
// ---------------------------------------------------------------------------

export {
  ACTIVE_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  TYPED_TERMINAL_CAUSES,
  CONVERSATION_EVENT_KINDS,
  PERMISSION_EVENT_KINDS,
  ELICITATION_EVENT_KINDS,
  SIDE_QUESTION_EVENT_KINDS,
  agentResponseText,
  applyAgentEvent,
  applySideQuestionEvent,
  arrayValue,
  attachRunMessage,
  displayValue,
  elicitationFromEvent,
  failOptimisticMessage,
  flushStreaming,
  initialConversationState,
  isString,
  messageFromRun,
  objectValue,
  optimisticUserMessage,
  permissionFromEvent,
  reduceAll as reduceAllConversationEvents,
  reduceConversation as reduceConversationEvent,
  rollbackOptimisticMessage,
  terminalCauseFromPayload,
} from './conversationReducer'

export type {
  ConversationInput,
  ConversationState,
  ElicitationAnswer,
  ElicitationOption,
  ElicitationProperty,
  PendingElicitation,
  PendingPermission,
  TerminalCause,
  TimelineEvent,
} from './conversationReducer'

export type PermissionChoice = { id: string; label: string; kind: string }

export type SessionPlanEntry = {
  content: string
  priority: string
  status: 'completed' | 'in_progress' | 'pending'
}

export const SESSION_STATE_EVENT_KINDS = new Set([
  'available_commands',
  'composer_catalog_snapshot',
  'config_options',
  'current_mode',
  'plan',
  'session_state',
  'session_info',
  'usage',
])
/**
 * Run completion converges from the terminal event itself (#92/#93); it never
 * triggers a session-state refetch.
 */
export const RUN_TERMINAL_EVENT_KINDS = new Set(['run_completed'])

export type TerminalNotice = {
  level: 'info' | 'warning' | 'error'
  messageKey: TranslationKey
}

/**
 * Maps a typed terminal cause onto user-facing surfacing (#93): cancellations
 * stay quiet; resource/refusal failures surface as errors. A plain end of
 * turn warrants nothing.
 */
export function terminalCauseNotice(
  cause: TerminalCause,
  t: Translator,
): { level: TerminalNotice['level']; message: string } | null {
  const notices: Partial<Record<TerminalCause, [TerminalNotice['level'], TranslationKey]>> = {
    cancelled: ['info', 'kubecode.runEndedCancelled'],
    interrupted: ['info', 'kubecode.runEndedInterrupted'],
    max_tokens: ['error', 'kubecode.runEndedMaxTokens'],
    max_turn_requests: ['error', 'kubecode.runEndedMaxTurnRequests'],
    refusal: ['error', 'kubecode.runEndedRefusal'],
    error: ['error', 'kubecode.runEndedError'],
  }
  const notice = notices[cause]
  if (!notice) return null
  return { level: notice[0], message: t(notice[1]) }
}
export const MAX_SESSION_TURN_PICKER_SOURCES = 20
export const MAX_SESSION_TURN_PREVIEW_CHARACTERS = 120

export function agentName(id: Conversation['agent_id']): string {
  if (id === 'claude_code') return 'Claude Code'
  if (id === 'opencode') return 'OpenCode'
  return 'Codex'
}

export function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

export function sessionPlanEntries(
  plan: Record<string, unknown> | null | undefined,
): SessionPlanEntry[] {
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

export function newClientMessageId(): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID()
  const bytes = new Uint8Array(16)
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export type UsageSnapshot = {
  used: number | null
  size: number | null
  cost: string | null
}

/** Leniently parses an ACP usage checkpoint ({ used, size, cost? }). */
export function parseUsage(value: unknown): UsageSnapshot | null {
  const usage = objectValue(value)
  if (!usage) return null
  const number = (input: unknown): number | null => (
    typeof input === 'number' && Number.isFinite(input) && input >= 0 ? input : null
  )
  const costObject = objectValue(usage.cost)
  const amount = number(costObject?.amount)
  const currency = textValue(costObject?.currency)
  return {
    used: number(usage.used),
    size: number(usage.size),
    cost: amount != null && currency ? `${currency} ${amount.toFixed(2)}` : null,
  }
}

export type UsageLevel = 'ok' | 'warning' | 'danger'

/** Thresholds (#106): amber above 75%, red above 90% of the context window. */
export function usageLevel(used: number, size: number): UsageLevel {
  if (size <= 0) return 'ok'
  const fraction = used / size
  if (fraction > 0.9) return 'danger'
  if (fraction > 0.75) return 'warning'
  return 'ok'
}

export function sessionTurnPreview(value: string): string | null {
  const preview = value.replace(/\s+/g, ' ').trim()
  if (!preview) return null
  return preview.length > MAX_SESSION_TURN_PREVIEW_CHARACTERS
    ? `${preview.slice(0, MAX_SESSION_TURN_PREVIEW_CHARACTERS - 3)}...`
    : preview
}

// ---------------------------------------------------------------------------
// History hydration: recorded sequences replay through the same reducer the
// live path feeds, so both produce identical state by construction (#103).
// ---------------------------------------------------------------------------

export type HydrationResult = {
  messages: AiAgentMessage[]
  activeRun: AgentRun | null
  pendingPermission: PendingPermission | null
  pendingElicitation: PendingElicitation | null
  sessionState: AgentSessionState
  sideQuestions: SideQuestionItem[]
  historyCursor: string | null
  runs: AgentRun[]
  /** The kernel state the transcript replay produced. */
  state: ConversationState
  /**
   * Global workspace cursor at snapshot time; live events at or below it are
   * already represented in the replayed state (#103 hydration dedupe).
   */
  workspaceCursor: number | null
}

/**
 * Replays run rows plus their ordered event streams into conversation state.
 * Every source of recorded history funnels through here.
 */
export function replayRecordedConversation(
  runs: AgentRun[],
  streamFor: (run: AgentRun) => Iterable<AgentEvent>,
  options: { /** Legacy per-run streams pre-seed each row's bubble. */
    seedMessages?: boolean } = {},
): ConversationState {
  const mode = options.seedMessages ? 'attach' : 'lookup'
  let state = reduceAll(
    initialConversationState(),
    runs.map((run) => ({ type: 'run' as const, run, mode })),
  )
  let synthetic = -1
  for (const run of runs) {
    for (const event of streamFor(run)) {
      state = reduceConversation(state, {
        type: 'event',
        event: {
          seq: Number.isFinite(event.seq) && event.seq >= 0 ? event.seq : synthetic--,
          kind: event.kind,
          payload: event.payload,
          runId: event.run_id || run.id,
          source: 'history',
        },
      })
    }
  }
  // End of transcript: crashed turns cannot linger as eternally-pending.
  return reduceConversation(state, { type: 'end_of_transcript' })
}

function sessionStream(events: SessionEvent[], runId: string): Iterable<AgentEvent> {
  return events
    .filter((event) => textValue(event.payload.run_id) === runId)
    .map((event) => ({
      created_at: event.created_at,
      kind: event.kind,
      payload: event.payload,
      run_id: runId,
      seq: event.seq,
    }))
}

function legacyEvents(page: ConversationHistoryPage, runId: string): AgentEvent[] {
  return page.events[runId] ?? []
}

export function messagesFromSessionEvents(
  events: SessionEvent[],
  runs: AgentRun[],
): AiAgentMessage[] {
  return replayRecordedConversation(
    runs,
    (run) => sessionStream(events, run.id),
  ).messages
}

export function messagesFromHistoryPage(page: ConversationHistoryPage): AiAgentMessage[] {
  if (page.session_events.length > 0) {
    return replayRecordedConversation(
      page.runs,
      (run) => sessionStream(page.session_events, run.id),
    ).messages
  }
  // Legacy pages carry per-run streams: their renderer seeded each bubble
  // from the row itself.
  return replayRecordedConversation(
    page.runs,
    (run) => legacyEvents(page, run.id),
    { seedMessages: true },
  ).messages
}

export async function hydrateConversation(
  api: KubecodeApi,
  conversationId: string,
): Promise<HydrationResult> {
  if (typeof api.getConversationHistory === 'function') {
    const [page, sessionState] = await Promise.all([
      api.getConversationHistory(conversationId),
      api.getSessionState(conversationId),
    ])
    return settledHydration({
      runs: page.runs,
      streamFor: (run) => page.session_events.length > 0
        ? sessionStream(page.session_events, run.id)
        : legacyEvents(page, run.id),
      sessionState,
      sideQuestions: sideQuestionsFromSessionEvents(page.session_events),
      historyCursor: page.next_cursor,
      fallbackActiveRun: page.runs.at(-1) ?? null,
      seedMessages: page.session_events.length === 0,
      workspaceCursor: page.workspace_cursor ?? null,
    })
  }
  const [runs, sessionEvents, sessionState] = await Promise.all([
    api.listRuns(conversationId),
    api.listSessionEvents(conversationId),
    api.getSessionState(conversationId),
  ])
  const legacyStreams = await Promise.all(runs.map((run) => api.listEvents(run.id)))
  const streamIndex = new Map(runs.map((run, index) => [run.id, legacyStreams[index]]))
  return settledHydration({
    runs,
    // A session-event transcript outranks per-run streams, mirroring the
    // pre-kernel renderer's precedence.
    streamFor: sessionEvents.length > 0
      ? (run) => sessionStream(sessionEvents, run.id)
      : (run) => streamIndex.get(run.id) ?? [],
    sessionState,
    sideQuestions: sideQuestionsFromSessionEvents(sessionEvents),
    historyCursor: null,
    fallbackActiveRun: runs.at(-1) ?? null,
    // Only fall back to row-seeded rendering when no session-event transcript
    // exists; with one present, events alone shape bubbles exactly as the
    // modern renderer did.
    seedMessages: sessionEvents.length === 0,
    workspaceCursor: null,
  })
}

async function settledHydration({
  runs,
  streamFor,
  sessionState,
  sideQuestions,
  historyCursor,
  fallbackActiveRun,
  seedMessages,
  workspaceCursor,
}: {
  runs: AgentRun[]
  streamFor: (run: AgentRun) => Iterable<AgentEvent>
  sessionState: AgentSessionState
  sideQuestions: SideQuestionItem[]
  historyCursor: string | null
  fallbackActiveRun: AgentRun | null
  seedMessages: boolean
  workspaceCursor: number | null
}): Promise<HydrationResult> {
  const state = replayRecordedConversation(runs, streamFor, { seedMessages })
  return {
    messages: state.messages,
    activeRun: fallbackActiveRun,
    pendingPermission: state.pendingPermission,
    pendingElicitation: state.pendingElicitation,
    sessionState,
    sideQuestions,
    historyCursor,
    runs,
    state,
    workspaceCursor,
  }
}

export function sideQuestionsFromSessionEvents(events: SessionEvent[]): SideQuestionItem[] {
  return events.reduce((items, event) => (
    SIDE_QUESTION_EVENT_KINDS.has(event.kind)
      ? applySideQuestionEvent(items, event.kind, event.payload)
      : items
  ), [] as SideQuestionItem[])
}

// ---------------------------------------------------------------------------
// Session-level helpers kept verbatim from before the kernel split.
// ---------------------------------------------------------------------------

export function availableCommands(
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

export function capabilityDisabledReason(reason: string | null, t: Translator): string {
  if (reason === 'ambiguous_source_identity') return t('kubecode.capabilityDisabledAmbiguous')
  if (reason === 'unsupported_input' || reason === 'unsupported_invocation') {
    return t('kubecode.capabilityDisabledUnsupported')
  }
  return t('kubecode.capabilityDisabledUnavailable')
}

export function gitDiffDisabledReason(reason: string | null, t: Translator): string {
  if (reason === 'git_diff_empty') return t('kubecode.gitDiffEmpty')
  if (reason === 'git_diff_binary') return t('kubecode.gitDiffBinary')
  if (reason === 'git_diff_generated') return t('kubecode.gitDiffGenerated')
  if (reason === 'git_diff_too_large') return t('kubecode.gitDiffTooLarge')
  if (reason === 'git_diff_too_many_hunks') return t('kubecode.gitDiffTooManyHunks')
  if (reason === 'git_diff_too_many_files') return t('kubecode.gitDiffTooManyFiles')
  if (reason === 'git_diff_contains_unsupported') {
    return t('kubecode.gitDiffContainsUnsupported')
  }
  return t('kubecode.gitDiffUnavailable')
}

export function canAskSideQuestion(
  conversation: Conversation,
  state: AgentSessionState | null,
  active: boolean,
): boolean {
  if (!active || conversation.agent_id !== 'claude_code') return false
  const meta = objectValue(state?.capabilities?._meta)
  const claudeCode = objectValue(meta?.claudeCode)
  return claudeCode?.sideQuestion === true
}

export function sideQuestionText(value: string): string | null {
  const match = value.trim().match(/^\/btw(?:\s+)([\s\S]+)$/)
  return match?.[1]?.trim() || null
}

export function sessionCapability(state: AgentSessionState | null, capability: string): boolean {
  const sessionCapabilities = state?.capabilities?.sessionCapabilities
  if (!sessionCapabilities || typeof sessionCapabilities !== 'object') return false
  return (sessionCapabilities as Record<string, unknown>)[capability] != null
}

export function sessionStateWithMode(
  state: AgentSessionState | null,
  currentModeId: string,
): AgentSessionState | null {
  if (!state?.current_mode) return state
  return {
    ...state,
    current_mode: { ...state.current_mode, currentModeId },
  }
}

export function sessionStateWithConfig(
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

export function nativeModeLockReason({
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

export function nativeModeLockMessage(
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

export function permissionChoiceLabel(option: PermissionChoice, t: Translator): string {
  if (option.kind === 'allow_always') return t('kubecode.allowAll')
  if (option.kind === 'allow_once') return t('kubecode.allow')
  if (option.kind === 'reject_once' || option.kind === 'reject_always') {
    return t('kubecode.reject')
  }
  return option.label
}

export function pendingPermissionFromEvents(events: AgentEvent[]): PendingPermission | null {
  return events.reduce<PendingPermission | null>((pending, event) => {
    if (event.kind === 'permission_requested') return permissionFromEvent(event) ?? pending
    if (event.kind !== 'permission_resolved') return pending
    const requestId = textValue(event.payload.request_id)
    return !requestId || pending?.requestId === requestId ? null : pending
  }, null)
}

export function pendingElicitationFromEvents(events: AgentEvent[]): PendingElicitation | null {
  return events.reduce<PendingElicitation | null>((pending, event) => {
    if (event.kind === 'elicitation_requested') return elicitationFromEvent(event) ?? pending
    if (event.kind !== 'elicitation_resolved') return pending
    const requestId = textValue(event.payload.request_id)
    return !requestId || pending?.requestId === requestId ? null : pending
  }, null)
}

export function initialElicitationAnswers(
  elicitation: PendingElicitation | null,
): Record<string, ElicitationAnswer> {
  return Object.fromEntries(
    elicitation?.properties.map((property) => [property.id, property.defaultValue]) ?? [],
  )
}

export function elicitationComplete(
  elicitation: PendingElicitation,
  answers: Record<string, ElicitationAnswer>,
): boolean {
  return elicitation.properties.every((property) => (
    !property.required || property.type === 'boolean'
      || String(answers[property.id] ?? '').trim().length > 0
  ))
}

export function elicitationContent(
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
