import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import { ApiError, type AgentRun, type KubecodeApi } from '../api'
import { useComposerController } from './useComposerController'
import type { AiAgentMessage } from '@/lib/aiAgentConversation'
import { attachRunMessage } from './sessionModel'
import { appendComposerText } from '../composerDraft'

const t = createTranslator('en')

type Harness = {
  messages: AiAgentMessage[]
}

type ApiMock = KubecodeApi & {
  listRuns: ReturnType<typeof vi.fn>
  registerComposerContext: ReturnType<typeof vi.fn>
  startPrompt: ReturnType<typeof vi.fn>
}

function makeApi(): ApiMock {
  return {
    listRuns: vi.fn().mockResolvedValue([]),
    registerComposerContext: vi.fn(),
    startPrompt: vi.fn(),
  } as unknown as ApiMock
}

function started(run: Partial<AgentRun> = {}): { admission: 'started'; run: AgentRun } {
  return {
    admission: 'started',
    run: {
      id: 'run-1',
      conversation_id: 'conversation-1',
      project_id: 'project-1',
      message: 'sent',
      status: 'running',
      permission_mode: 'safe',
      error: null,
      ...run,
    },
  }
}

function queued(item: Partial<import('../api').PromptQueueItem> = {}): {
  admission: 'queued'
  item: import('../api').PromptQueueItem
} {
  return {
    admission: 'queued',
    item: {
      id: 'queue-1',
      conversation_id: 'conversation-1',
      project_id: 'project-1',
      content: 'sent',
      status: 'pending',
      position: 1,
      internal: false,
      created_at: 'now',
      ...item,
    },
  }
}

function renderController(
  api: KubecodeApi,
  options: {
    active?: boolean
    catalog?: import('../api').ComposerCatalogSnapshot
    run?: AgentRun | null
  } = {},
) {
  const { active = false, catalog, run = null } = options
  const harness: Harness = { messages: [] }
  const reportError = vi.fn()
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
    active,
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
    reportError,
    run,
    sessionState: catalog ? ({ composer: { catalog } } as never) : null,
    setSideQuestions: vi.fn(),
    t,
    viewRevisionId: null,
  }))
  return { ...hook, harness, reportError }
}

describe('useComposerController optimistic send', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('adds the user bubble before the POST resolves and reconciles by client id', async () => {
    let resolveStart: (value: unknown) => void = () => {}
    const api = makeApi()
    api.startPrompt.mockImplementation(() => new Promise((resolve) => {
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
    expect(api.startPrompt).toHaveBeenCalledTimes(1)
    const [, , , clientMessageId] = vi.mocked(api.startPrompt).mock.calls[0]
    expect(clientMessageId).toMatch(/^[0-9a-f-]{36}$/)

    await act(async () => {
      resolveStart(started({
        id: 'run-1',
        message: 'Hello optimistically',
        client_message_id: clientMessageId,
      }))
      await sendPromise
    })
    expect(harness.messages).toHaveLength(1)
    expect(harness.messages[0]?.id).toBe('run-1')
  })

  it('keeps the bubble as a failed turn when the server rejects the request', async () => {
    const api = makeApi()
    api.startPrompt.mockRejectedValue(new ApiError('invalid_request', 'Bad draft', 400))
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
    api.startPrompt.mockRejectedValue(new TypeError('network blip'))
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
    api.startPrompt.mockRejectedValue(new TypeError('network down'))
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
    api.startPrompt.mockRejectedValue(new TypeError('network down'))
    const { result } = renderController(api)

    await act(async () => {
      await result.current.updatePrompt('Original')
    })
    await act(async () => {
      await result.current.send('Original')
    })
    const firstId = vi.mocked(api.startPrompt).mock.calls[0][3]

    await act(async () => {
      await result.current.updatePrompt('Original, edited')
    })
    api.startPrompt.mockResolvedValue(started({
      id: 'run-2',
      message: 'Original, edited',
    }))
    await act(async () => {
      await result.current.send('Original, edited')
    })

    const secondId = vi.mocked(api.startPrompt).mock.calls[1][3]
    expect(secondId).not.toBe(firstId)
    expect(secondId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('queues while a run is active and keeps the optimistic bubble until drain', async () => {
    const api = makeApi()
    api.startPrompt.mockResolvedValue(queued({ content: 'While busy' }))
    const attachRun = vi.fn()
    const { result, harness } = renderController(api, { active: true })

    await act(async () => {
      await result.current.updatePrompt('While busy')
    })
    await act(async () => {
      await result.current.send('While busy')
    })

    expect(api.startPrompt).toHaveBeenCalledTimes(1)
    const [projectId, conversationId, message, clientMessageId] =
      vi.mocked(api.startPrompt).mock.calls[0]
    expect(projectId).toBe('project-1')
    expect(conversationId).toBe('conversation-1')
    expect(message).toBe('While busy')
    expect(clientMessageId).toMatch(/^[0-9a-f-]{36}$/)
    // The optimistic bubble stays keyed by the client id until the deferred
    // run materializes and reconciles it.
    expect(harness.messages).toHaveLength(1)
    expect(harness.messages[0]?.id).toBe(clientMessageId)
    expect(harness.messages[0]?.userMessage).toBe('While busy')
    expect(attachRun).not.toHaveBeenCalled()
    expect(result.current.prompt).toBe('')
  })

  it('steers a queued prompt now when the accelerated gesture is used', async () => {
    const api = makeApi()
    api.startPrompt.mockResolvedValue(queued({ content: 'Steer me' }))
    api.sendPromptQueueNow = api.sendPromptQueueNow ?? vi.fn()
    const sendPromptQueueNow = vi.fn().mockResolvedValue({
      id: 'queue-1',
      conversation_id: 'conversation-1',
      project_id: 'project-1',
      content: 'Steer me',
      status: 'claimed',
      position: 0,
      internal: false,
      created_at: 'now',
    })
    api.sendPromptQueueNow = sendPromptQueueNow
    const { result } = renderController(api, { active: true })

    await act(async () => {
      await result.current.updatePrompt('Steer me')
    })
    await act(async () => {
      await result.current.send('Steer me', { sendNow: true })
    })

    expect(sendPromptQueueNow).toHaveBeenCalledWith('conversation-1', 'queue-1')
  })

  it('still starts a run immediately when the conversation is idle', async () => {
    const clientMessageId = 'aaaa1111-2222-4333-8444-555555555555'
    vi.stubGlobal('crypto', {
      ...globalThis.crypto,
      randomUUID: vi.fn(() => clientMessageId),
    })
    const api = makeApi()
    api.startPrompt.mockResolvedValue(started({
      message: 'Now',
      client_message_id: clientMessageId,
    }))
    const { result, harness } = renderController(api)

    await act(async () => {
      await result.current.updatePrompt('Now')
    })
    await act(async () => {
      await result.current.send('Now')
    })

    expect(harness.messages).toHaveLength(1)
    expect(harness.messages[0]?.id).toBe('run-1')
    vi.unstubAllGlobals()
  })

  describe('Project work references', () => {
    beforeEach(() => {
      // Drafts persist per conversation; start each case clean.
      window.sessionStorage.clear()
    })

    const item = (kind: 'finding' | 'session' | 'session_turn', id: string) => ({
      ref: { kind, id, revision: '1' },
      title: 'Accuracy holds',
      summary: 'A private summary that must not travel',
      provenance: {
        author: 'agent', updated_at: null, research_id: null, parent: null, state: null,
      },
      availability: 'available' as const,
    })
    const registration = {
      context: {
        id: 'ctx:project-work:1',
        kind: 'project_context',
        display: 'Accuracy holds',
        enabled: true,
        disabled_reason: null,
        summary: {
          kind: 'project_context', ref_kind: 'finding', revision: '1', title: 'Accuracy holds',
        },
      },
      catalog: { conversation_id: 'conversation-1', revision: 4, items: [], contexts: [] },
    }

    it('registers only the typed reference and adds the returned opaque chip to the draft', async () => {
      const api = makeApi()
      api.registerComposerContext.mockResolvedValue(registration)
      const { result } = renderController(api)
      await act(async () => {
        result.current.insertComposerProjectContext(item('finding', 'f1'))
      })
      expect(api.registerComposerContext).toHaveBeenCalledWith('conversation-1', {
        kind: 'project_context',
        path: 'finding:f1',
        source_revision: '1',
      })
      const body = JSON.stringify(api.registerComposerContext.mock.calls)
      expect(body).not.toContain('private summary')
      expect(body).not.toContain('Accuracy holds')
      const chips = result.current.composerDraft.segments.filter((segment) => segment.kind === 'context')
      expect(chips).toHaveLength(1)
      expect(chips[0]).toMatchObject({
        reference: {
          id: 'ctx:project-work:1',
          kind: 'project_context',
          name: 'Finding: Accuracy holds',
          availability: 'available',
        },
      })
    })

    it('keeps the draft with its chips flagged for revalidation when a source moved on before send', async () => {
      const api = makeApi()
      api.registerComposerContext.mockResolvedValue(registration)
      api.startStructuredRun = vi.fn().mockRejectedValue(
        new ApiError('composer_context_stale', 'Referenced context changed', 409),
      )
      const { result, harness, reportError } = renderController(api, {
        catalog: { conversation_id: 'conversation-1', revision: 4, items: [], contexts: [] },
      })
      await act(async () => {
        result.current.insertComposerProjectContext(item('finding', 'f1'))
      })
      await act(async () => {
        result.current.updateComposerDraft((draft) => appendComposerText(draft, 'Build on this'))
      })
      await act(async () => {
        await result.current.send('Build on this')
      })
      expect(api.startStructuredRun).toHaveBeenCalledTimes(1)
      // The failed attempt leaves no bubble, and the researcher keeps the draft.
      expect(harness.messages).toHaveLength(0)
      expect(reportError).toHaveBeenCalledTimes(1)
      const chips = result.current.composerDraft.segments.filter((segment) => segment.kind === 'context')
      expect(chips).toHaveLength(1)
      expect(chips[0]).toMatchObject({ reference: { availability: 'stale', kind: 'project_context' } })
      expect(JSON.stringify(result.current.composerDraft)).toContain('Build on this')
    })

    it('does not offer the current Session or its turns, and reports a failed registration', async () => {
      const api = makeApi()
      api.registerComposerContext.mockRejectedValue(new ApiError('composer_context_stale', 'stale', 409))
      const { result, reportError } = renderController(api)
      await act(async () => {
        result.current.insertComposerProjectContext(item('session', 'conversation-1'))
        result.current.insertComposerProjectContext(item('session_turn', 'conversation-1/run-1'))
      })
      expect(api.registerComposerContext).not.toHaveBeenCalled()
      await act(async () => {
        result.current.insertComposerProjectContext(item('finding', 'f1'))
      })
      expect(reportError).toHaveBeenCalledTimes(1)
      expect(
        result.current.composerDraft.segments.filter((segment) => segment.kind === 'context'),
      ).toHaveLength(0)
    })
  })
})