import type { AiAction } from '@/components/AiMessage'
import type { AiAgentMessage } from '@/lib/aiAgentConversation'
import type { TranslationKey, TranslationValues } from '@/lib/i18n'

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

export type Translator = (key: TranslationKey, values?: TranslationValues) => string
export type PermissionChoice = { id: string; label: string; kind: string }
export type PendingPermission = { requestId: string; tool: string; options: PermissionChoice[] }
export type ElicitationAnswer = string | boolean
export type ElicitationOption = { id: string; name: string }
export type ElicitationProperty = {
  defaultValue: ElicitationAnswer
  description: string
  id: string
  label: string
  options: ElicitationOption[]
  required: boolean
  type: 'boolean' | 'integer' | 'number' | 'string'
}
export type PendingElicitation = {
  message: string
  properties: ElicitationProperty[]
  requestId: string
}

export type SessionPlanEntry = {
  content: string
  priority: string
  status: 'completed' | 'in_progress' | 'pending'
}

export const ACTIVE_RUN_STATUSES = new Set<AgentRun['status']>(['running', 'waiting_permission'])
export const SESSION_STATE_EVENT_KINDS = new Set([
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
export const SESSION_TIMELINE_EVENT_KINDS = new Set([
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
export const SIDE_QUESTION_EVENT_KINDS = new Set([
  'side_question_completed',
  'side_question_failed',
  'side_question_started',
])
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

export function textValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null
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

export function isString(value: unknown): value is string {
  return typeof value === 'string'
}

export function displayValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

export function messageFromRun(run: AgentRun): AiAgentMessage {
  return {
    actions: [],
    id: run.id,
    isStreaming: ACTIVE_RUN_STATUSES.has(run.status),
    reasoningDone: !ACTIVE_RUN_STATUSES.has(run.status),
    userMessage: run.message,
    internal: Boolean(run.internal),
  }
}

export function agentResponseText(message: AiAgentMessage): string {
  return message.responseBlocks?.map((block) => block.text).join('') ?? message.response ?? ''
}

export function sessionTurnPreview(value: string): string | null {
  const preview = value.replace(/\s+/g, ' ').trim()
  if (!preview) return null
  return preview.length > MAX_SESSION_TURN_PREVIEW_CHARACTERS
    ? `${preview.slice(0, MAX_SESSION_TURN_PREVIEW_CHARACTERS - 3)}...`
    : preview
}

export function nativeMessage(event: SessionEvent, text: string): AiAgentMessage {
  return {
    actions: [],
    id: `native-${event.seq}`,
    isStreaming: false,
    reasoningDone: true,
    userMessage: text,
  }
}

export function messagesFromSessionEvents(
  events: SessionEvent[],
  runs: AgentRun[],
): AiAgentMessage[] {
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

export function messagesFromHistoryPage(page: ConversationHistoryPage): AiAgentMessage[] {
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

export async function hydrateConversation(
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

export function permissionChoiceLabel(option: PermissionChoice, t: Translator): string {
  if (option.kind === 'allow_always') return t('kubecode.allowAll')
  if (option.kind === 'allow_once') return t('kubecode.allow')
  if (option.kind === 'reject_once' || option.kind === 'reject_always') {
    return t('kubecode.reject')
  }
  return option.label
}

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

export function sideQuestionsFromSessionEvents(events: SessionEvent[]): SideQuestionItem[] {
  return events.reduce((items, event) => (
    SIDE_QUESTION_EVENT_KINDS.has(event.kind)
      ? applySideQuestionEvent(items, event.kind, event.payload)
      : items
  ), [] as SideQuestionItem[])
}

export function applySideQuestionEvent(
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

export function elicitationFromEvent(event: AgentEvent): PendingElicitation | null {
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

export function applyAgentEvent(
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

export function permissionFromEvent(event: AgentEvent): PendingPermission | null {
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
