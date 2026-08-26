import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import { ApiError, type AgentRun, type KubecodeApi } from '../api'
import { useComposerController } from './useComposerController'
import type { AiAgentMessage } from '@/lib/aiAgentConversation'
import { attachRunMessage } from './sessionModel'

const t = createTranslator('en')

type Harness = {
  messages: AiAgentMessage[]
}

type ApiMock = KubecodeApi & {
  listRuns: ReturnType<typeof vi.fn>
  startRun: ReturnType<typeof vi.fn>
}

function makeApi(): ApiMock {
  return {
    listRuns: vi.fn().mockResolvedValue([]),
    startRun: vi.fn(),
  } as unknown as ApiMock
}

function renderController(api: KubecodeApi) {
  const harness: Harness = { messages: [] }
  const appendOptimisticMessage = (message: AiAgentMessage) => {
    harness.messages = [...harness.messages, message]
  }
  const removeOptimisticMessage = (clientMessageId: string) => {
    harness.messages = harness.messages.filter((message) => message.id !== clientMessageId)
  }
  const failOptimisticMessage = (clientMessageId: string) => {
    harness.messages = harness.messages.map((message) => (
      message.id === clientMessageId && message.isStreaming
        ? { ...message, isStreaming: false }
        : message
    ))
  }
  const hook = renderHook(() => useComposerController({
    active: false,
    agent: { id: 'opencode', available: true } as never,
    api,
    appendOptimisticMessage,
    attachRun: (nextRun: AgentRun) => {
      harness.messages = attachRunMessage(harness.messages, nextRun)
    },
    commands: [],
    conversation: {
      id: 'conversation-1',
      project_id: 'project-1',
      agent_id: 'opencode',
    } as never,
    conversationId: 'conversation-1',
    directTeammateChatDisabled: false,
    failOptimisticMessage,
    hardReadOnly: false,
    messages: [] as never,
    onApplyComposerCatalog: vi.fn(),
    onClearError: vi.fn(),
    projectId: 'project-1',
    removeOptimisticMessage,
    reportError: vi.fn(),
    run: null,
    sessionState: null,
    setSideQuestions: vi.fn(),
    t,
    viewRevisionId: null,
  }))
  return { ...hook, harness }
}

describe('useComposerController optimistic send', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('adds the user bubble before the POST resolves and reconciles by client id', async () => {
    let resolveStart: (value: unknown) => void = () => {}
    const api = makeApi()
    api.startRun.mockImplementation(() => new Promise((resolve) => {
      resolveStart = resolve
    }))
    const { result, harness } = renderController(api)

    await act(async () => {
      await result.current.updatePrompt('Hello optimistically')
    })
    let sendPromise: Promise<void> = Promise.resolve()
    act(() => {
      sendPromise = result.current.send(result.current.prompt)
    })
    // The bubble is already present while the request is still pending.
    expect(harness.messages).toHaveLength(1)
    expect(harness.messages[0]?.userMessage).toBe('Hello optimistically')
    expect(result.current.prompt).toBe('')
    expect(api.startRun).toHaveBeenCalledTimes(1)
    const [, , , clientMessageId] = vi.mocked(api.startRun).mock.calls[0]
    expect(clientMessageId).toMatch(/^[0-9a-f-]{36}$/)

    await act(async () => {
      resolveStart({
        id: 'run-1',
        conversation_id: 'conversation-1',
        project_id: 'project-1',
        message: 'Hello optimistically',
        status: 'running',
        permission_mode: 'safe',
        error: null,
        client_message_id: clientMessageId,
      })
      await sendPromise
    })
    expect(harness.messages).toHaveLength(1)
    expect(harness.messages[0]?.id).toBe('run-1')
  })

  it('keeps the bubble as a failed turn when the server rejects the request', async () => {
    const api = makeApi()
    api.startRun.mockRejectedValue(new ApiError('invalid_request', 'Bad draft', 400))
    const { result, harness } = renderController(api)

    await act(async () => {
      await result.current.updatePrompt('Rejected')
    })
    await act(async () => {
      await result.current.send('Rejected')
    })

    expect(harness.messages).toHaveLength(1)
    expect(harness.messages[0]?.isStreaming).toBe(false)
    expect(result.current.prompt).toBe('')
    expect(api.listRuns).not.toHaveBeenCalled()
  })

  it('reconciles instead of rolling back when the run actually started', async () => {
    const clientMessageId = '11111111-2222-4333-8444-555555555555'
    vi.stubGlobal('crypto', {
      ...globalThis.crypto,
      randomUUID: vi.fn(() => clientMessageId),
    })
    const api = makeApi()
    api.startRun.mockRejectedValue(new TypeError('network blip'))
    api.listRuns.mockResolvedValue([{
      id: 'run-remote',
      conversation_id: 'conversation-1',
      project_id: 'project-1',
      message: 'Ambiguous',
      status: 'running',
      permission_mode: 'safe',
      error: null,
      client_message_id: clientMessageId,
    }])
    const { result, harness } = renderController(api)

    await act(async () => {
      await result.current.updatePrompt('Ambiguous')
    })
    await act(async () => {
      await result.current.send('Ambiguous')
    })

    expect(api.listRuns).toHaveBeenCalledWith('conversation-1')
    expect(harness.messages).toHaveLength(1)
    expect(harness.messages[0]?.id).toBe('run-remote')
    expect(result.current.prompt).toBe('')
    vi.unstubAllGlobals()
  })

  it('rolls the bubble back and restores the draft on transport failure', async () => {
    const api = makeApi()
    api.startRun.mockRejectedValue(new TypeError('network down'))
    const { result, harness } = renderController(api)

    await act(async () => {
      await result.current.updatePrompt('Never sent')
    })
    await act(async () => {
      await result.current.send('Never sent')
    })

    expect(harness.messages).toHaveLength(0)
    expect(result.current.prompt).toBe('Never sent')
  })

  it('reuses the pending client id only for an identical resend', async () => {
    const api = makeApi()
    api.startRun.mockRejectedValue(new TypeError('network down'))
    const { result } = renderController(api)

    await act(async () => {
      await result.current.updatePrompt('Original')
    })
    await act(async () => {
      await result.current.send('Original')
    })
    const firstId = vi.mocked(api.startRun).mock.calls[0][3]

    await act(async () => {
      await result.current.updatePrompt('Original, edited')
    })
    api.startRun.mockResolvedValue({
      id: 'run-2',
      conversation_id: 'conversation-1',
      project_id: 'project-1',
      message: 'Original, edited',
      status: 'running',
      permission_mode: 'safe',
      error: null,
    })
    await act(async () => {
      await result.current.send('Original, edited')
    })

    const secondId = vi.mocked(api.startRun).mock.calls[1][3]
    expect(secondId).not.toBe(firstId)
    expect(secondId).toMatch(/^[0-9a-f-]{36}$/)
  })
})
