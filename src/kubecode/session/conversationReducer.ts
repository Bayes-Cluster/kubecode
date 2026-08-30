import type { AiAction } from '@/components/AiMessage'
import type { AiAgentMessage } from '@/lib/aiAgentConversation'

import type { SideQuestionItem } from '../SideQuestionPanel'
import type { AgentEvent, AgentRun } from '../api'

/**
 * One pure reducer applies conversation events regardless of source (#103):
 * live SSE, history hydration, and future reconnect replays all feed the same
 * `reduceConversation`, so every downstream consumer — including #93's
 * terminal-event convergence — reads derived state instead of patching beside
 * parallel code paths.
 */

export const ACTIVE_RUN_STATUSES = new Set<AgentRun['status']>(['running', 'waiting_permission'])

export const TERMINAL_RUN_STATUSES = new Set<AgentRun['status']>([
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'interrupted',
])

export const TYPED_TERMINAL_CAUSES = [
  'end_turn',
  'cancelled',
  'error',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'interrupted',
] as const

export type TerminalCause = (typeof TYPED_TERMINAL_CAUSES)[number]

/** Transcript-shaped conversation kinds the reducer routes itself. */
export const CONVERSATION_EVENT_KINDS = new Set([
  'user_message',
  'user_message_delta',
  'run_started',
  'error',
  'text_delta',
  'thinking_delta',
  'tool_started',
  'tool_updated',
  'tool_completed',
])

export const PERMISSION_EVENT_KINDS = new Set(['permission_requested', 'permission_resolved'])

export const ELICITATION_EVENT_KINDS = new Set(['elicitation_requested', 'elicitation_resolved'])

export const SIDE_QUESTION_EVENT_KINDS = new Set([
  'side_question_completed',
  'side_question_failed',
  'side_question_started',
])

type PermissionChoice = { id: string; label: string; kind: string }
export type PendingPermission = { requestId: string; tool: string; options: PermissionChoice[] }
export type PendingElicitation = {
  requestId: string
  message: string
  properties: ElicitationProperty[]
}
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

/** A conversation event plus the channel it arrived on. */
export type TimelineEvent = {
  /** Monotonic sequence within its source: workspace id or session seq. */
  seq: number
  kind: string
  payload: Record<string, unknown>
  runId: string | null
  source: 'live' | 'history'
}

/** One agent-agnostic subagent bubble (#108), keyed by sub-session id. */
export type SubagentEntry = {
  subSessionId: string
  /** Synthetic transcript events attributed to this sub (spliced + routed). */
  events: TimelineEvent[]
  /** Latest envelope status: running until a completed envelope lands. */
  status: 'running' | 'completed'
  name: string
  prompt: string
  conversationId: string | null
}

export type ConversationState = {
  messages: AiAgentMessage[]
  /** Run rows revealed so far, keyed by run id. */
  runs: Record<string, AgentRun>
  /** Subagent bubbles keyed by sub-session id (#107/#108). */
  subagents: Record<string, SubagentEntry>
  pendingPermission: PendingPermission | null
  pendingElicitation: PendingElicitation | null
  sideQuestions: SideQuestionItem[]
  /** Namespaced `source:seq` keys already folded (replay idempotence). */
  appliedSeqs: ReadonlySet<string>
  /**
   * Transcript events that arrived before their run row did; they replay in
   * order the moment the run attaches.
   */
  bufferedByRun: Readonly<Record<string, readonly TimelineEvent[]>>
}

export type ConversationInput =
  | { type: 'event'; event: TimelineEvent }
  /**
   * A run row became available. `attach` surfaces its bubble (live paths);
   * `lookup` only registers it so hydration replays can resolve run-scoped
   * facts (titles, terminal causes) while transcript bubbles materialize
   * solely from the recorded events, matching the legacy renderer (#103).
   */
  | { type: 'run'; run: AgentRun; mode?: 'attach' | 'lookup' }
  /** Marks the end of a bounded replay; force-completes stuck tools. */
  | { type: 'end_of_transcript' }
  /**
   * Composer-originated bubble states funnel through the same kernel so every
   * message mutation has exactly one definition (#103).
   */
  | { type: 'optimistic'; message: AiAgentMessage }
  | { type: 'rollback_optimistic'; clientMessageId: string }
  | { type: 'fail_optimistic'; clientMessageId: string }

export function initialConversationState(): ConversationState {
  return {
    messages: [],
    runs: {},
    subagents: {},
    pendingPermission: null,
    pendingElicitation: null,
    sideQuestions: [],
    appliedSeqs: new Set(),
    bufferedByRun: {},
  }
}

export function isString(value: unknown): value is string {
  return typeof value === 'string'
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

export function displayValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

export function terminalCauseFromPayload(payload: Record<string, unknown>): TerminalCause | null {
  const cause = textValue(payload.cause)
  if (!cause) return null
  return (TYPED_TERMINAL_CAUSES as readonly string[]).includes(cause)
    ? cause as TerminalCause
    : null
}

/**
 * Folds one input into the next conversation state. Pure: never mutates its
 * input, and identical sequences produce identical states whether they arrive
 * live or are replayed from history.
 */
export function reduceConversation(
  state: ConversationState,
  input: ConversationInput,
): ConversationState {
  switch (input.type) {
    case 'end_of_transcript':
      return flushStreaming(state)
    case 'run':
      return attachRun(state, input.run, input.mode ?? 'attach')
    case 'event':
      // Cross-channel replays stay idempotent: handlers mark the event once
      // they have truly folded it, so a redelivery is a no-op while plain
      // buffering stays transparent.
      return applyTimelineEvent(state, input.event)
    case 'optimistic': {
      const message = input.message
      if (state.messages.some((candidate) => candidate.id === message.id)) return state
      return { ...state, messages: [...state.messages, message] }
    }
    case 'rollback_optimistic':
      return {
        ...state,
        messages: rollbackOptimisticMessage(state.messages, input.clientMessageId),
      }
    case 'fail_optimistic':
      return {
        ...state,
        messages: failOptimisticMessage(state.messages, input.clientMessageId),
      }
  }
}

export function reduceAll(
  state: ConversationState,
  inputs: Iterable<ConversationInput>,
): ConversationState {
  let current = state
  for (const input of inputs) current = reduceConversation(current, input)
  return current
}

/**
 * Fello-style hydration merge (#103): live inputs buffered while a history
 * fetch was in flight fold on top of the fetched state, dropping events at or
 * below the fetch-time workspace cursor — the page already contains them, so
 * folding both copies would double every overlapping chunk. Inputs without a
 * workspace sequence (optimistic bubbles, run rows, replay markers) always
 * fold, and a missing cursor degrades to a plain fold.
 */
export function mergeLiveOverHistory(
  state: ConversationState,
  inputs: readonly ConversationInput[],
  workspaceCursor: number | null,
): ConversationState {
  if (workspaceCursor == null) return reduceAll(state, inputs)
  const kept = inputs.filter((input) => (
    input.type !== 'event' || input.event.source !== 'live'
      || input.event.seq > workspaceCursor
  ))
  return reduceAll(state, kept)
}

// ---------------------------------------------------------------------------
// Event routing
// ---------------------------------------------------------------------------

function applyTimelineEvent(state: ConversationState, event: TimelineEvent): ConversationState {
  const next = routeTimelineEvent(state, event)
  return withSeq(next, event)
}

function routeTimelineEvent(state: ConversationState, event: TimelineEvent): ConversationState {
  // Runless user-typing deltas open native turns without any run context.
  if (event.kind === 'user_message_delta') {
    return routeUserTurn(state, event)
      ?? { ...state, messages: [
          ...state.messages,
          nativeMessage(timelineAsAgentEvent(event), textValue(event.payload.text)),
        ] }
  }
  if (SIDE_QUESTION_EVENT_KINDS.has(event.kind)) {
    return {
      ...state,
      sideQuestions: applySideQuestionEvent(state.sideQuestions, event.kind, event.payload),
    }
  }
  if (PERMISSION_EVENT_KINDS.has(event.kind)) {
    return applyPermissionEvent(state, event)
  }
  if (ELICITATION_EVENT_KINDS.has(event.kind)) {
    return applyElicitationEvent(state, event)
  }
  if (event.kind === 'subagent_update') {
    return applySubagentUpdate(state, event)
  }
  // Tagged tool events belong to a sub session (#108) — routed into the
  // bubble whether they arrive before or after the registration envelope;
  // a toolId already folded into main is spliced out on attribution.
  if (
    (event.kind === 'tool_started' || event.kind === 'tool_updated' || event.kind === 'tool_completed')
    && textValue(event.payload.subagent_session_id)
  ) {
    return withSubSplice(applySubTaggedEvent(state, event), event)
  }
  if (event.kind === 'run_completed') {
    return applyRunCompleted(state, event)
  }
  const runId = event.runId ?? textValue(event.payload.run_id)
  if (!CONVERSATION_EVENT_KINDS.has(event.kind) || !runId) {
    // Kinds outside this reducer's scope (plan, usage, catalog…) still count
    // as folded so cross-source replay stays idempotent.
    return state
  }
  return applyTranscriptEvent(state, { ...event, runId })
}

function applyPermissionEvent(state: ConversationState, event: TimelineEvent): ConversationState {
  if (event.kind === 'permission_requested') {
    const requested = permissionFromEvent(event)
    return requested ? { ...state, pendingPermission: requested } : state
  }
  const requestId = textValue(event.payload.request_id)
  if (!requestId || state.pendingPermission?.requestId === requestId) {
    return { ...state, pendingPermission: null }
  }
  return state
}

function applyElicitationEvent(state: ConversationState, event: TimelineEvent): ConversationState {
  if (event.kind === 'elicitation_requested') {
    const requested = elicitationFromEvent(event)
    return requested ? { ...state, pendingElicitation: requested } : state
  }
  const requestId = textValue(event.payload.request_id)
  if (!requestId || state.pendingElicitation?.requestId === requestId) {
    return { ...state, pendingElicitation: null }
  }
  return state
}

/**
 * Terminal convergence lives here (#93): completion events carry the typed
 * cause (#92), so the reducer finalizes the run — status, cause, bubble —
 * from the event alone with no follow-up fetch.
 */
function applyRunCompleted(state: ConversationState, event: TimelineEvent): ConversationState {
  const runId = event.runId ?? textValue(event.payload.run_id)
  if (!runId || !state.runs[runId]) {
    return bufferForUnknownRun(state, event)
  }
  const existing = state.runs[runId]
  const reportedStatus = textValue(event.payload.status)
  const cause = terminalCauseFromPayload(event.payload)
  const run: AgentRun = {
    ...existing,
    status: isAgentRunStatus(reportedStatus) ? reportedStatus : existing.status,
    error: event.payload.error == null ? existing.error : String(event.payload.error),
    ...(cause ? { terminal_cause: cause } : {}),
  }
  return {
    ...state,
    runs: { ...state.runs, [runId]: run },
    messages: completeBubble(state.messages, runId),
  }
}

const AGENT_RUN_STATUSES: readonly AgentRun['status'][] = [
  'running',
  'waiting_permission',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'interrupted',
]

function isAgentRunStatus(value: string): value is AgentRun['status'] {
  return (AGENT_RUN_STATUSES as readonly string[]).includes(value)
}

function completeBubble(
  messages: AiAgentMessage[],
  runId: string,
): AiAgentMessage[] {
  return messages.map((message) => (
    message.id === runId ? { ...message, isStreaming: false, reasoningDone: true } : message
  ))
}

function applyTranscriptEvent(state: ConversationState, event: TimelineEvent): ConversationState {
  const runId = event.runId as string
  // Whole-turn kinds shape their own bubbles regardless of attachment state;
  // hydration replays rely on them materializing without a prior attach.
  const turn = routeUserTurn(state, event)
  if (turn) return turn
  const knownBubble = state.messages.some((message) => message.id === runId)
  if (!knownBubble) {
    // A bubble exists only once its run attached; hold deltas meanwhile so a
    // live stream racing a history fetch loses nothing.
    return bufferForUnknownRun(state, event)
  }
  return {
    ...state,
    messages: applyAgentEvent(state.messages, runId, timelineAsAgentEvent(event)),
  }
}

/** `user_message`/`user_message_delta` shape whole new turns, not bubbles. */
function routeUserTurn(state: ConversationState, event: TimelineEvent): ConversationState | null {
  if (event.kind !== 'user_message' && event.kind !== 'user_message_delta') return null
  if (event.kind === 'user_message') return appendUserMessage(state, event)
  const last = state.messages.at(-1)
  const text = textValue(event.payload.text)
  if (last?.id?.startsWith('native-') && !last.response && !last.reasoning) {
    return {
      ...state,
      messages: [
        ...state.messages.slice(0, -1),
        { ...last, userMessage: `${last.userMessage ?? ''}${text}` },
      ],
    }
  }
  return {
    ...state,
    messages: [...state.messages, nativeMessage(timelineAsAgentEvent(event), text)],
  }
}

function appendUserMessage(state: ConversationState, event: TimelineEvent): ConversationState {
  const runId = textValue(event.payload.run_id) || event.runId || ''
  const canonicalRun = state.runs[runId]
  const canonical = canonicalRun ? messageFromRun(canonicalRun) : null
  const clientMessageId = textValue(event.payload.client_message_id)

  // Reconcile an optimistic bubble carrying this client id instead of
  // appending a duplicate turn (fello-style display-id reconciliation).
  const reconciledMessages = clientMessageId
    ? reconcileOptimistic(state.messages, clientMessageId, canonicalRun ?? null)
    : null
  if (reconciledMessages) return { ...state, messages: reconciledMessages }

  let appended: AiAgentMessage
  if (event.payload.internal === true) {
    appended = canonical
      ? { ...canonical, internal: true, userMessage: '' }
      : { ...nativeMessage(timelineAsAgentEvent(event)), internal: true, userMessage: '' }
  } else if (canonical) {
    appended = canonical
  } else {
    appended = nativeMessage(timelineAsAgentEvent(event), textValue(event.payload.text))
  }
  if (state.messages.some((message) => message.id === appended.id)) return state
  return { ...state, messages: [...state.messages, appended] }
}

function reconcileOptimistic(
  messages: AiAgentMessage[],
  clientMessageId: string,
  run: AgentRun | null,
): AiAgentMessage[] | null {
  const optimisticIndex = messages.findIndex((message) => message.id === clientMessageId)
  if (optimisticIndex < 0) return null
  // Without the run row the canonical bubble cannot be built yet; keep the
  // optimistic one until `attachRun` lands with it.
  if (!run) return null
  return messages.map((message, index) => (
    index === optimisticIndex ? messageFromRun(run) : message
  ))
}

function bufferForUnknownRun(state: ConversationState, event: TimelineEvent): ConversationState {
  const runId = event.runId ?? textValue(event.payload.run_id)
  if (!runId) return state
  const buffered = state.bufferedByRun[runId] ?? []
  // Buffered events are deliberately not marked applied until they drain, so
  // this list itself must reject re-deliveries.
  if (buffered.some((candidate) => eventKey(candidate) === eventKey(event))) return state
  return {
    ...state,
    bufferedByRun: { ...state.bufferedByRun, [runId]: [...buffered, event] },
  }
}

/**
 * Mis-route repair (#108): tool calls tagged `subagent_session_id` that
 * arrive before their registration envelope land in a provisional sub
 * entry; the later envelope merges into it — so the ordered and
 * mis-ordered replays of the same sequence render identically.
 */
function subEntryForEvent(state: ConversationState, event: TimelineEvent): SubagentEntry {
  const sessionId = textValue(event.payload.subagent_session_id)
  const existing = state.subagents[sessionId]
  return {
    subSessionId: sessionId,
    events: existing?.events ?? [],
    status: existing?.status ?? 'running',
    name: existing?.name ?? '',
    prompt: existing?.prompt ?? '',
    conversationId: existing?.conversationId ?? null,
  }
}

function applySubagentUpdate(state: ConversationState, event: TimelineEvent): ConversationState {
  const sessionId = textValue(event.payload.sessionId)
  if (!sessionId) return state
  const name = textValue(event.payload.name)
  const status = textValue(event.payload.status) === 'completed' ? 'completed' : 'running'
  const conversationId = textValue(event.payload.conversation_id) || null
  const prompt = textValue(event.payload.prompt)

  const existing = state.subagents[sessionId]
  const merged: SubagentEntry = {
    ...(existing ?? {
      subSessionId: sessionId,
      events: [],
      name: '',
      prompt: '',
      conversationId: null,
    }),
    // Registration backfills the name/prompt without clobbering state.
    name: name || existing?.name || '',
    prompt: prompt || existing?.prompt || '',
    conversationId: conversationId ?? existing?.conversationId ?? null,
    status,
  }
  const subagents = { ...state.subagents, [sessionId]: merged }
  return { ...state, subagents }
}

/**
 * Splice-out (#108): a tagged tool event whose toolId already landed in a
 * main message (folded before the tag was recognized) is removed from main
 * as it is attributed to the sub entry.
 */
function withSubSplice(
  next: ConversationState,
  event: TimelineEvent,
): ConversationState {
  const toolId = textValue(event.payload.tool_id)
  if (!toolId) return next
  const hadMain = next.messages.some((message) =>
    message.actions.some((action) => action.toolId === toolId),
  )
  if (!hadMain) return next
  return {
    ...next,
    messages: next.messages.map((message) => ({
      ...message,
      actions: message.actions.filter((action) => action.toolId !== toolId),
    })),
  }
}

/** Routes a tool event tagged for a sub session into its provisional entry. */
function applySubTaggedEvent(state: ConversationState, event: TimelineEvent): ConversationState {
  const entry = subEntryForEvent(state, event)
  const subagents = {
    ...state.subagents,
    [entry.subSessionId]: {
      ...entry,
      events: [...entry.events, event],
      status: event.kind === 'tool_completed' ? 'completed' as const : entry.status,
    },
  }
  return { ...state, subagents }
}

// ---------------------------------------------------------------------------
// Run attachment
// ---------------------------------------------------------------------------

function attachRun(
  state: ConversationState,
  run: AgentRun,
  mode: 'attach' | 'lookup' = 'attach',
): ConversationState {
  const next: ConversationState = {
    ...state,
    runs: { ...state.runs, [run.id]: run },
  }
  if (mode === 'lookup') return next
  const hadBubble = state.messages.some((message) => message.id === run.id)
  let working = next
  if (!hadBubble) {
    working = { ...working, messages: attachRunMessage(working.messages, run) }
  }
  const buffered = working.bufferedByRun[run.id]
  if (!buffered) return working
  let drained: ConversationState = {
    ...working,
    bufferedByRun: omitKey(working.bufferedByRun, run.id),
  }
  for (const event of buffered) {
    // The bubble exists now, so these fold directly instead of re-buffering.
    drained = reduceConversation(drained, { type: 'event', event })
  }
  return drained
}

function omitKey(
  record: Readonly<Record<string, readonly TimelineEvent[]>>,
  key: string,
): Record<string, readonly TimelineEvent[]> {
  if (!(key in record)) return { ...record }
  const next = { ...record }
  delete next[key]
  return next
}

/** Live workspace cursors and recorded session seqs live in different id
 * spaces; namespace before storing so cross-source replays stay idempotent
 * without falsely dropping one channel's events because of the other. */
export function eventKey(event: Pick<TimelineEvent, 'source' | 'seq'>): string {
  return `${event.source}:${event.seq}`
}

function withSeq(state: ConversationState, event: TimelineEvent): ConversationState {
  const key = eventKey(event)
  if (state.appliedSeqs.has(key)) return state
  const appliedSeqs = new Set(state.appliedSeqs)
  appliedSeqs.add(key)
  return { ...state, appliedSeqs }
}

// ---------------------------------------------------------------------------
// Replay hygiene
// ---------------------------------------------------------------------------

/**
 * Force-completes artifacts a crashed run never closed: an in-progress tool
 * call or still-streaming bubble with no terminal event at end of transcript
 * renders as terminated instead of eternally pending. Runs that are active
 * server-side keep streaming — only finished transcripts get synthesized
 * terminals.
 */
export function flushStreaming(state: ConversationState): ConversationState {
  let changed = false
  const messages = state.messages.map((message) => {
    const run = message.id ? state.runs[message.id] : undefined
    if (!run || ACTIVE_RUN_STATUSES.has(run.status)) return message
    const stuckIds = new Set(
      message.actions.filter((action) => action.status === 'pending').map((a) => a.toolId),
    )
    if (stuckIds.size === 0 && !message.isStreaming) return message
    changed = true
    return {
      ...message,
      isStreaming: false,
      reasoningDone: true,
      actions: stuckIds.size === 0
        ? message.actions
        : message.actions.map((action) => (
          stuckIds.has(action.toolId) ? { ...action, status: 'done' as const } : action
        )),
    }
  })
  return changed ? { ...state, messages } : state
}

// ---------------------------------------------------------------------------
// Event -> model mappers shared by every source.
// ---------------------------------------------------------------------------

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

export function optimisticUserMessage(clientMessageId: string, text: string): AiAgentMessage {
  return {
    actions: [],
    id: clientMessageId,
    isStreaming: true,
    reasoningDone: false,
    userMessage: text,
  }
}

export function attachRunMessage(current: AiAgentMessage[], run: AgentRun): AiAgentMessage[] {
  if (current.some((message) => message.id === run.id)) return current
  const withoutOptimistic = run.client_message_id
    ? current.filter((message) => message.id !== run.client_message_id)
    : current
  return [...withoutOptimistic, messageFromRun(run)]
}

export function rollbackOptimisticMessage(
  current: AiAgentMessage[],
  clientMessageId: string,
): AiAgentMessage[] {
  return current.filter((message) => message.id !== clientMessageId)
}

export function failOptimisticMessage(
  current: AiAgentMessage[],
  clientMessageId: string,
): AiAgentMessage[] {
  return current.map((message) => (
    message.id === clientMessageId && message.isStreaming
      ? { ...message, isStreaming: false }
      : message
  ))
}

export function agentResponseText(message: AiAgentMessage): string {
  return message.responseBlocks?.map((block) => block.text).join('') ?? message.response ?? ''
}

function nativeMessage(event: AgentEvent, text = ''): AiAgentMessage {
  return {
    actions: [],
    id: `native-${event.seq}`,
    isStreaming: false,
    reasoningDone: true,
    userMessage: text,
  }
}

function timelineAsAgentEvent(event: TimelineEvent): AgentEvent {
  return {
    created_at: '',
    kind: event.kind,
    payload: event.payload,
    run_id: event.runId ?? '',
    seq: event.seq,
  }
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

export function permissionFromEvent(event: TimelineEvent | AgentEvent): PendingPermission | null {
  const requestId = textValue(event.payload.request_id)
  if (textValue(event.payload.reviewer) === 'leader') return null
  const optionsRaw = arrayValue(event.payload.options)
  if (!requestId || !optionsRaw) return null
  const options = optionsRaw.flatMap((value) => {
    const option = objectValue(value)
    const id = textValue(option?.id)
    const label = textValue(option?.label)
    if (!id || !label) return []
    return [{ id, label, kind: textValue(option?.kind) }]
  })
  return { requestId, tool: textValue(event.payload.tool) || 'Tool', options }
}

export function elicitationFromEvent(event: TimelineEvent | AgentEvent): PendingElicitation | null {
  const requestId = textValue(event.payload.request_id)
  const message = textValue(event.payload.message)
  const schema = objectValue(event.payload.requestedSchema)
  const values = objectValue(schema?.properties)
  if (!requestId || !message || !values) return null
  const required = new Set(arrayValue(schema?.required)?.filter(isString) ?? [])
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
  return { requestId, message, properties }
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

// ---------------------------------------------------------------------------
// Frame-budgeted application queue
// ---------------------------------------------------------------------------

export type ConversationPumpOptions<T> = {
  /** Hard per-frame budget; a heavy stream never blocks longer than this. */
  budgetMs?: number
  /**
   * Schedules a drain and returns its cancellation. Defaults to
   * requestAnimationFrame in the browser.
   */
  schedule?: (drain: () => void) => () => void
  /** Monotonic clock, injectable for deterministic tests. */
  now?: () => number
  onDrain: (items: readonly T[]) => void
}

/**
 * Fello-style pump (#103): incoming items enqueue; each scheduled drain
 * applies a bounded batch under `budgetMs` so a 1k-event stream never renders
 * as one long task. Items drain strictly FIFO per queue — conversation-level
 * fairness is preserved by giving every conversation its own pump.
 */
export function createConversationPump<T>(options: ConversationPumpOptions<T>): {
  push: (item: T) => void
  flush: () => void
  pendingCount: () => number
  dispose: () => void
} {
  const budgetMs = options.budgetMs ?? 8
  const now = options.now ?? (() => performance.now())
  const schedule = options.schedule ?? ((drain) => {
    const handle = requestAnimationFrame(drain)
    return () => cancelAnimationFrame(handle)
  })
  const queue: T[] = []
  let cancelDrain: (() => void) | null = null

  function runDrain(): void {
    cancelDrain = null
    if (queue.length === 0) return
    const start = now()
    let consumed = 0
    while (queue.length > 0 && (consumed === 0 || now() - start < budgetMs)) {
      // Always take at least one item per frame: progress outranks budgets.
      options.onDrain([queue.shift() as T])
      consumed += 1
    }
    if (queue.length > 0) scheduleNext()
  }

  function scheduleNext(): void {
    if (cancelDrain) return
    cancelDrain = schedule(runDrain)
  }

  return {
    push(item) {
      queue.push(item)
      scheduleNext()
    },
    flush() {
      if (cancelDrain) {
        cancelDrain()
        cancelDrain = null
      }
      while (queue.length > 0) options.onDrain([queue.shift() as T])
    },
    pendingCount: () => queue.length,
    dispose() {
      if (cancelDrain) cancelDrain()
      cancelDrain = null
      queue.length = 0
    },
  }
}
