import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { AgentRun, KubecodeApi } from '../api'
import { terminalCauseNotice } from './sessionModel'
import type { TimelineEvent } from './conversationReducer'
import { useSessionHistory } from './useSessionHistory'

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1',
    conversation_id: 'conversation-1',
    project_id: 'project-1',
    message: 'Do the thing',
    status: 'running',
    permission_mode: 'safe',
    error: null,
    ...overrides,
  }
}

type ApiMock = KubecodeApi & Record<string, ReturnType<typeof vi.fn>>

function makeApi(): ApiMock {
  return {
    getRun: vi.fn(),
    listRuns: vi.fn().mockResolvedValue([]),
    listSessionEvents: vi.fn().mockResolvedValue([]),
    listEvents: vi.fn().mockResolvedValue([]),
    getSessionState: vi.fn().mockResolvedValue({ capabilities: null }),
  } as unknown as ApiMock
}

const CONVERSATION = {
  id: 'conversation-1',
  agent_id: 'opencode',
} as never

const STABLE = {
  beginSessionStateRequest: () => () => undefined,
  reportError: (cause: unknown) => {
    throw cause
  },
  setComposerCatalogLoadFailed: () => {},
  setWorkspaceWarning: () => {},
  t: ((key: string) => key) as never,
}

function renderTranscript(api: ApiMock, onRunTerminal?: (cause: string) => void) {
  const hook = renderHook(() => useSessionHistory({
    api,
    beginSessionStateRequest: STABLE.beginSessionStateRequest,
    onRunTerminal: onRunTerminal as never,
    conversation: CONVERSATION,
    conversationId: 'conversation-1',
    directTeammateChatDisabled: false,
    hardReadOnly: false,
    projectId: 'project-1',
    reportError: STABLE.reportError,
    setComposerCatalogLoadFailed: STABLE.setComposerCatalogLoadFailed,
    setWorkspaceWarning: STABLE.setWorkspaceWarning,
    t: STABLE.t,
  }))
  return hook.result
}

function liveEvent(seq: number, kind: string, payload: Record<string, unknown>, runId = 'run-1'): TimelineEvent {
  return { seq, kind, payload, runId, source: 'live' }
}

describe('terminal convergence (#93)', () => {
  it('finalizes the watched run from the completion event without any follow-up fetch', async () => {
    const api = makeApi()
    const result = renderTranscript(api)
    await waitFor(() => expect(api.listRuns).toHaveBeenCalled())
    expect(api.getRun).not.toHaveBeenCalled()

    act(() => {
      result.current.transcript.attachRun(makeRun())
    })
    expect(result.current.transcript.active).toBe(true)

    // An unknown-run delta is intentionally absent here; the completion alone
    // must converge the header.
    act(() => {
      result.current.transcript.enqueueConversationEvents([
        liveEvent(11, 'run_completed', { status: 'completed', cause: 'max_tokens' }),
      ])
    })

    await waitFor(() => expect(result.current.transcript.run?.status).toBe('completed'))
    expect(result.current.transcript.run?.terminal_cause).toBe('max_tokens')
    expect(result.current.transcript.active).toBe(false)
    // Zero refetches for run/session state around completion.
    expect(api.getRun).not.toHaveBeenCalled()
    expect(api.getSessionState).toHaveBeenCalledTimes(1)
  })

  it('never flips a terminal run back to active on a stale running row', async () => {
    const api = makeApi()
    const result = renderTranscript(api)
    await waitFor(() => expect(api.listRuns).toHaveBeenCalled())
    act(() => {
      result.current.transcript.enqueueConversationEvents([
        liveEvent(20, 'run_completed', { status: 'completed', cause: 'end_turn' }, 'ghost'),
      ])
    })
    act(() => {
      result.current.transcript.attachRun(makeRun({ id: 'ghost', status: 'completed' }))
    })
    await waitFor(() => {
      expect(result.current.transcript.run?.status).toBe('completed')
    })
    // A late re-fetch returning a running row for the same id cannot revive
    // the header: the stickiness guard wins and the row stays terminal.
    act(() => {
      result.current.transcript.attachRun(makeRun({ id: 'ghost', status: 'running' }))
    })
    await waitFor(() => {
      expect(result.current.transcript.run?.status).toBe('completed')
    })
    expect(result.current.transcript.active).toBe(false)
  })

  it('fires one terminal observation per run and cause', async () => {
    const api = makeApi()
    const seen: Array<[string, string]> = []
    const result = renderTranscript(api, (cause) => {
      seen.push([cause, result.current.transcript.run?.id ?? ''])
    })
    await waitFor(() => expect(api.listRuns).toHaveBeenCalled())
    act(() => {
      result.current.transcript.attachRun(makeRun({ id: 'obs' }))
    })
    act(() => {
      result.current.transcript.enqueueConversationEvents([
        liveEvent(31, 'run_completed', { status: 'failed', cause: 'refusal' }, 'obs'),
        liveEvent(32, 'run_completed', { status: 'failed', cause: 'refusal' }, 'obs'),
      ])
    })
    await waitFor(() => expect(seen.length).toBeGreaterThan(0))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.[0]).toBe('refusal')
  })

  it('stays silent while replaying hydrated history', async () => {
    const api = makeApi()
    api.listRuns.mockResolvedValue([makeRun({
      id: 'historic',
      status: 'cancelled',
      terminal_cause: 'cancelled',
    })])
    api.listSessionEvents.mockResolvedValue([])
    api.listEvents.mockResolvedValue([])
    const observations: string[] = []
    renderTranscript(api, (cause) => observations.push(cause))
    await waitFor(() => expect(api.listRuns).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(observations).toEqual([])
  })
})

describe('terminalCauseNotice copy mapping', () => {
  const t = (key: string) => `copy:${key}`

  it('keeps cancellations quiet and resource failures loud', () => {
    expect(terminalCauseNotice('end_turn', t)).toBeNull()
    expect(terminalCauseNotice('cancelled', t)).toMatchObject({ level: 'info' })
    expect(terminalCauseNotice('interrupted', t)).toMatchObject({ level: 'info' })
    for (const cause of ['error', 'max_tokens', 'max_turn_requests', 'refusal'] as const) {
      expect(terminalCauseNotice(cause, t)).toMatchObject({ level: 'error' })
      expect(terminalCauseNotice(cause, t)?.message.startsWith('copy:kubecode.runEnded')).toBe(true)
    }
  })
})
