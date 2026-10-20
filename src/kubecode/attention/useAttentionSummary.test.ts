import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AttentionSummary, KubecodeApi, WorkspaceEvent } from '../api'
import { useAttentionSummary } from './useAttentionSummary'

const event = (id: number, kind: string, payload: Record<string, unknown> = {}): WorkspaceEvent => ({
  id, kind, project_id: 'p2', conversation_id: null, run_id: null, payload, created_at: '',
})
const summary = (cursor: number, decisions: number): AttentionSummary => ({
  cursor,
  workspaces: [{ project_id: 'p2', decisions, setup: 0, permissions: 0, undelivered: 0, incomplete: false }],
})

function setup(attentionSummary: ReturnType<typeof vi.fn>) {
  const api = { attentionSummary } as unknown as KubecodeApi
  return renderHook(
    ({ events }: { events: WorkspaceEvent[] }) => useAttentionSummary(api, events, 'live'),
    { initialProps: { events: [] as WorkspaceEvent[] } },
  )
}

afterEach(() => vi.useRealTimers())

describe('useAttentionSummary', () => {
  it('reads the counts at once, and again after a change that can add or remove a decision anywhere', async () => {
    const attentionSummary = vi.fn().mockResolvedValueOnce(summary(1, 0)).mockResolvedValue(summary(2, 1))
    const view = setup(attentionSummary)
    await waitFor(() => expect(view.result.current?.cursor).toBe(1))
    // A proposal shown in General, a suggestion or a revised brief: channel and research changes count.
    view.rerender({ events: [event(5, 'channel_updated')] })
    await waitFor(() => expect(view.result.current?.cursor).toBe(2), { timeout: 3_000 })
    view.rerender({ events: [event(5, 'channel_updated'), event(6, 'research_updated')] })
    await waitFor(() => expect(attentionSummary).toHaveBeenCalledTimes(3), { timeout: 3_000 })
  })

  it('never replaces newer counts with an older answer', async () => {
    let answerFirst!: (value: AttentionSummary) => void
    const attentionSummary = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { answerFirst = resolve }))
      .mockResolvedValue(summary(9, 3))
    const view = setup(attentionSummary)
    view.rerender({ events: [event(7, 'task_updated')] })
    await waitFor(() => expect(view.result.current?.cursor).toBe(9), { timeout: 3_000 })
    answerFirst(summary(4, 1))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(view.result.current?.cursor).toBe(9)
  })

  it('ignores changes that cannot alter what waits', async () => {
    const attentionSummary = vi.fn().mockResolvedValue(summary(1, 0))
    const view = setup(attentionSummary)
    await waitFor(() => expect(attentionSummary).toHaveBeenCalledTimes(1))
    view.rerender({ events: [event(8, 'terminal_output')] })
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(attentionSummary).toHaveBeenCalledTimes(1)
  })
})
