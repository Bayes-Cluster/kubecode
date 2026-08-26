import { describe, expect, it } from 'vitest'

import type { AiAgentMessage } from '@/lib/aiAgentConversation'

import {
  attachRunMessage,
  messageFromRun,
  optimisticUserMessage,
  rollbackOptimisticMessage,
} from './sessionModel'
import type { AgentRun } from '../api'

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

describe('optimisticUserMessage', () => {
  it('creates a pending bubble keyed by the client message id', () => {
    const message = optimisticUserMessage('client-1', 'Hello')
    expect(message.id).toBe('client-1')
    expect(message.userMessage).toBe('Hello')
    expect(message.isStreaming).toBe(true)
    expect(message.reasoningDone).toBe(false)
  })
})

describe('attachRunMessage', () => {
  it('replaces the optimistic bubble instead of appending a duplicate', () => {
    const optimistic = optimisticUserMessage('client-1', 'Hello')
    const next = attachRunMessage([optimistic], run({ client_message_id: 'client-1' }))
    expect(next).toHaveLength(1)
    expect(next[0]?.id).toBe('run-1')
    expect(next[0]?.userMessage).toBe('Canonical text')
  })

  it('appends the canonical message when the run carries no client id', () => {
    const optimistic = optimisticUserMessage('client-1', 'Hello')
    const next = attachRunMessage([optimistic], run())
    expect(next).toHaveLength(2)
    expect(next.map((message) => message.id)).toEqual(['client-1', 'run-1'])
  })

  it('is a no-op when the run message is already attached', () => {
    const messages: AiAgentMessage[] = [messageFromRun(run())]
    expect(attachRunMessage(messages, run())).toBe(messages)
  })

  it('keeps earlier messages while reconciling the tail bubble', () => {
    const earlier = messageFromRun(run({ id: 'run-0' }))
    const optimistic = optimisticUserMessage('client-1', 'Hello')
    const next = attachRunMessage([earlier, optimistic], run({ client_message_id: 'client-1' }))
    expect(next.map((message) => message.id)).toEqual(['run-0', 'run-1'])
  })
})

describe('rollbackOptimisticMessage', () => {
  it('removes only the matching optimistic bubble', () => {
    const earlier = messageFromRun(run({ id: 'run-0' }))
    const optimistic = optimisticUserMessage('client-1', 'Hello')
    const next = rollbackOptimisticMessage([earlier, optimistic], 'client-1')
    expect(next).toHaveLength(1)
    expect(next[0]?.id).toBe('run-0')
  })
})
