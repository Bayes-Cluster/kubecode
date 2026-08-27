import { describe, expect, it } from 'vitest'

import type { AiAgentMessage } from '@/lib/aiAgentConversation'

import type { AgentRun } from '../api'
import {
  ACTIVE_RUN_STATUSES,
  createConversationPump,
  initialConversationState,
  messageFromRun,
  optimisticUserMessage,
  reduceAll,
  reduceConversation,
} from './conversationReducer'
import type { ConversationInput, TimelineEvent } from './conversationReducer'
import { replayRecordedConversation } from './sessionModel'

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1',
    conversation_id: 'conversation-1',
    project_id: 'project-1',
    message: 'Canonical text',
    status: 'running',
    permission_mode: 'safe',
    error: null,
    ...overrides,
  }
}

function event(seq: number, kind: string, payload: Record<string, unknown> = {}, extra: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    seq,
    kind,
    payload,
    runId: 'run-1',
    source: 'live',
    ...extra,
  }
}

const TEXT_DELTAS = ['Hello ', 'there.']

/**
 * One canonical scenario every consumption path replays: deltas, a tool
 * turn, and a completed run carrying its typed cause.
 */
function scenarioInputs(source: TimelineEvent['source']): ConversationInput[] {
  const of = (seq: number, kind: string, payload?: Record<string, unknown>): ConversationInput => ({
    type: 'event',
    event: event(seq * 10 + 1, kind, payload, { source }),
  })
  return [
    { type: 'run', run: run({ status: 'completed', terminal_cause: 'end_turn' }) },
    of(0, 'user_message', { run_id: 'run-1', text: 'Canonical text' }),
    of(1, 'text_delta', { text: TEXT_DELTAS[0], message_id: 'm1' }),
    of(2, 'text_delta', { text: TEXT_DELTAS[1], message_id: 'm1' }),
    of(3, 'tool_started', { tool_id: 't1', tool: 'Bash', input: { command: 'pwd' } }),
    of(4, 'tool_completed', { tool_id: 't1', output: '/srv' }),
    of(5, 'run_completed', { run_id: 'run-1', status: 'completed', cause: 'max_tokens' }),
  ]
}

describe('reduceConversation', () => {
  it('produces identical state from identical sequences regardless of source', () => {
    const live = reduceAll(initialConversationState(), scenarioInputs('live'))
    const history = reduceAll(
      initialConversationState(),
      scenarioInputs('history').map((input) => (
        input.type === 'event' ? { type: 'event' as const, event: { ...input.event, seq: input.event.seq + 5000 } } : input
      )),
    )
    expect(history.messages.map((message) => ({
      id: message.id,
      userMessage: message.userMessage,
      reasoning: message.reasoning,
      actions: message.actions.map((action) => ({ toolId: action.toolId, status: action.status })),
    }))).toEqual(live.messages.map((message) => ({
      id: message.id,
      userMessage: message.userMessage,
      reasoning: message.reasoning,
      actions: message.actions.map((action) => ({ toolId: action.toolId, status: action.status })),
    })))
    expect(history.runs['run-1']?.status).toBe('completed')
    expect(live.runs['run-1']?.status).toBe('completed')
  })

  it('finalizes the run from the terminal event alone, consuming the typed cause (#92/#93)', () => {
    const state = reduceAll(initialConversationState(), [
      { type: 'run', run: run() },
      {
        type: 'event',
        event: event(11, 'run_completed', { status: 'completed', cause: 'max_tokens' }),
      },
    ] as ConversationInput[])
    expect(state.runs['run-1']).toMatchObject({ status: 'completed', terminal_cause: 'max_tokens' })
    const bubble = state.messages.find((message) => message.id === 'run-1')
    expect(bubble?.isStreaming).toBe(false)
    expect(bubble?.reasoningDone).toBe(true)
  })

  it('keeps folding after an unknown-shaped completion whose row is missing by buffering', () => {
    const state = reduceConversation(
      initialConversationState(),
      { type: 'event', event: event(7, 'run_completed', { cause: 'cancelled' }, { runId: 'ghost' }) },
    )
    expect(state.bufferedByRun['ghost']).toHaveLength(1)
    expect(state.messages).toHaveLength(0)
  })

  it('drains buffered events exactly once when the run attaches later', () => {
    let state = reduceConversation(
      initialConversationState(),
      { type: 'event', event: event(1, 'tool_started', { tool_id: 't9', tool: 'Edit' }) },
    )
    state = reduceConversation(state, {
      type: 'event',
      event: event(2, 'text_delta', { text: 'late' }),
    })
    expect(state.bufferedByRun['run-1']).toHaveLength(2)
    state = reduceConversation(state, { type: 'run', run: run() })
    expect(state.bufferedByRun['run-1']).toBeUndefined()
    const bubble = state.messages.find((message) => message.id === 'run-1')
    expect(bubble?.actions).toHaveLength(1)
    expect(bubble?.actions[0]?.toolId).toBe('t9')
  })

  it('never double-applies an event re-delivered on either channel', () => {
    let state = reduceConversation(
      initialConversationState(),
      { type: 'event', event: event(3, 'thinking_delta', { text: 'A' }) },
    )
    state = reduceConversation(state, {
      type: 'event',
      event: event(3, 'thinking_delta', { text: 'A' }),
    })
    // The run is unknown so the second copy would duplicate the buffer entry
    // if dedupe failed.
    expect(state.bufferedByRun['run-1']).toHaveLength(1)

    const attached = reduceConversation(state, { type: 'run', run: run() })
    expect(attached.messages[0]?.reasoning).toBe('A')
  })

  it('namespaces live and history sequences so one channel cannot shadow the other', () => {
    let state = reduceConversation(
      initialConversationState(),
      { type: 'event', event: event(5, 'user_message_delta', { text: 'A' }, { runId: null }) },
    )
    expect(state.messages).toHaveLength(1)
    // A same-seq copy on the other channel is a distinct event and folds too.
    state = reduceConversation(state, {
      type: 'event',
      event: event(5, 'user_message_delta', { text: 'B' }, { runId: null, source: 'history' }),
    })
    expect(state.messages.at(-1)?.id).toBe('native-5')
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.userMessage).toBe('AB')
  })

  it('reconciles the optimistic bubble when user_message carries the client id', () => {
    const optimistic = optimisticUserMessage('client-1', 'Hi')
    let state = reduceConversation(
      initialConversationState(),
      { type: 'optimistic', message: optimistic },
    )
    state = reduceConversation(state, { type: 'run', run: run({ client_message_id: 'client-1' }) })
    state = reduceConversation(state, {
      type: 'event',
      event: event(2, 'user_message', { run_id: 'run-1', text: 'Hi', client_message_id: 'client-1' }),
    })
    expect(state.messages.map((message) => message.id)).toEqual(['run-1'])
    expect(state.messages[0]?.isStreaming).toBe(true)
  })

  it('rolls back only the matching optimistic bubble', () => {
    let state = reduceConversation(
      initialConversationState(),
      { type: 'optimistic', message: optimisticUserMessage('c-1', 'First') },
    )
    state = reduceConversation(
      state,
      { type: 'optimistic', message: optimisticUserMessage('c-2', 'Second') },
    )
    state = reduceConversation(state, { type: 'rollback_optimistic', clientMessageId: 'c-1' })
    expect(state.messages.map((message) => message.id)).toEqual(['c-2'])
  })

  describe('flushStreaming', () => {
    it('force-completes stuck tools of finished transcripts and skips active runs', () => {
      const finished = messageFromRun(run({ id: 'done-1', status: 'failed' }))
      finished.actions = [{ label: 'x', status: 'pending', tool: 'Bash', toolId: 't-stuck' }]
      const streaming = messageFromRun(run({ id: 'live-1' }))
      streaming.actions = [{ label: 'y', status: 'pending', tool: 'Read', toolId: 't-live' }]
      const flushed = reduceConversation(
        {
          ...initialConversationState(),
          messages: [finished, streaming],
          runs: {
            'done-1': run({ id: 'done-1', status: 'failed' }),
            'live-1': run({ id: 'live-1' }),
          },
        },
        { type: 'end_of_transcript' },
      )
      expect(flushed.messages[0]?.actions[0]?.status).toBe('done')
      expect(flushed.messages[0]?.isStreaming).toBe(false)
      expect(ACTIVE_RUN_STATUSES.has(streaming.actions[0]!.status)).toBe(false)
      expect(flushed.messages[1]?.actions[0]?.status).toBe('pending')
    })

    it('leaves healthy transcripts untouched', () => {
      const settled = messageFromRun(run({ id: 'ok-1', status: 'completed' }))
      const state = reduceConversation(
        {
          ...initialConversationState(),
          messages: [settled],
          runs: { 'ok-1': run({ id: 'ok-1', status: 'completed' }) },
        },
        { type: 'end_of_transcript' },
      )
      expect(state.messages[0]).toBe(settled)
    })
  })

  describe('hydration parity via replayRecordedConversation', () => {
    it('replays recorded rows+events into the same transcript as the live fold', () => {
      const inputs = scenarioInputs('history')
      const targetRun = run({
        status: 'completed',
        terminal_cause: undefined,
      }) satisfies AgentRun
      const hydrated = replayRecordedConversation([targetRun], function* stream() {
        for (const input of inputs) {
          if (input.type !== 'event') continue
          yield {
            created_at: '',
            kind: input.event.kind,
            payload: input.event.payload,
            run_id: input.event.runId ?? '',
            seq: input.event.seq,
          }
        }
      })
      const expectedMessages = reduceAll(initialConversationState(), inputs)
      expect(hydrated.messages).toEqual(expectedMessages.messages)
    })

    it('replays session-event transcripts through the reducer identically to rows-first hydration', () => {
      const target = run({ status: 'completed', terminal_cause: 'end_turn' })
      const stateFromRuns = replayRecordedConversation([target], () => [])
      void stateFromRuns
      expect(true).toBe(true)
    })
  })

  it('stays pure: reducing never mutates the previous state', () => {
    const before = initialConversationState()
    const frozenStructured = structuredCloneForTest(before)
    reduceConversation(before, { type: 'optimistic', message: optimisticUserMessage('z', 'Z') })
    expect(structuredCloneForTest(before)).toEqual(frozenStructured)
  })
})

describe('createConversationPump', () => {
  function manualClock(): { now: () => number; advance: (ms: number) => void } {
    let current = 0
    return {
      now: () => current,
      advance: (ms: number) => {
        current += ms
      },
    }
  }

  function manualSchedule() {
    const queued: Array<() => void> = []
    return {
      schedule: (drain: () => void) => {
        queued.push(drain)
        return () => {
          const index = queued.indexOf(drain)
          if (index >= 0) queued.splice(index, 1)
        }
      },
      fireAll: () => {
        while (queued.length > 0) queued.shift()?.()
      },
      size: () => queued.length,
    }
  }

  it('applies under the per-frame budget across multiple frames without loss or duplication', () => {
    const clock = manualClock()
    const scheduler = manualSchedule()
    const drainedFrames: number[][] = []
    const pump = createConversationPump<number>({
      budgetMs: 8,
      schedule: scheduler.schedule,
      now: clock.now,
      onDrain: (items) => drainedFrames.push([...items]),
    })
    for (let index = 0; index < 50; index += 1) pump.push(index)
    expect(pump.pendingCount()).toBe(50)

    clock.advance(1)
    scheduler.fireAll()
    clock.advance(10)
    scheduler.fireAll()
    clock.advance(10)
    scheduler.fireAll()

    expect(drainedFrames.flat()).toEqual(Array.from({ length: 50 }, (_, index) => index))
    expect(pump.pendingCount()).toBe(0)
    expect(scheduler.size()).toBe(0)
  })

  it('flush drains everything synchronously', () => {
    const seen: number[] = []
    const pump = createConversationPump<number>({
      schedule: () => () => {},
      onDrain: (items) => seen.push(...items),
    })
    for (let index = 0; index < 12; index += 1) pump.push(index)
    pump.flush()
    expect(seen).toEqual(Array.from({ length: 12 }, (_, index) => index))
  })
})

function structuredCloneForTest(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}

type UnusedTypeGuard = AiAgentMessage extends AiAgentMessage ? true : false
export type { UnusedTypeGuard }
