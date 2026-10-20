import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { KubecodeApi, Member } from '../../api'
import { useDmTarget } from './useDmTarget'

const member = (overrides: Partial<Member>): Member => ({
  id: 'm1', project_id: 'p1', role: 'specialist', template: 'specialist', name: 'Analyst',
  handle: 'analyst', spec: { agent_id: 'opencode', config: {}, instructions: '' },
  public_conversation_id: 's1', dm_conversation_id: null, state: 'active', setup_error: null,
  setup_code: null, revision: 1, created_at: '', updated_at: '', removed_at: null, ...overrides,
})

function api(openMemberDm: (projectId: string, memberId: string) => Promise<Member>) {
  return { openMemberDm: vi.fn(openMemberDm) } as unknown as KubecodeApi & { openMemberDm: ReturnType<typeof vi.fn> }
}

describe('useDmTarget', () => {
  it('uses the roster member when the conversation already exists, without opening it again', () => {
    const client = api(() => Promise.reject(new Error('not called')))
    const known = member({ dm_conversation_id: 's-dm' })
    const { result } = renderHook(() => useDmTarget(client, 'p1', 'm1', [known]))
    expect(result.current).toEqual({ status: 'ready', member: known })
    expect(client.openMemberDm).not.toHaveBeenCalled()
  })

  it('waits for the roster, then opens the conversation once', async () => {
    const opened = member({ dm_conversation_id: 's-dm' })
    const client = api(() => Promise.resolve(opened))
    const { rerender, result } = renderHook(
      ({ roster }) => useDmTarget(client, 'p1', 'm1', roster),
      { initialProps: { roster: null as Member[] | null } },
    )
    expect(result.current.status).toBe('loading')
    expect(client.openMemberDm).not.toHaveBeenCalled()
    rerender({ roster: [member({})] })
    await waitFor(() => expect(result.current).toEqual({ status: 'ready', member: opened }))
    rerender({ roster: [member({ revision: 2 })] })
    expect(client.openMemberDm).toHaveBeenCalledTimes(1)
    expect(client.openMemberDm).toHaveBeenCalledWith('p1', 'm1')
  })

  it('never shows a conversation opened for another Workspace', async () => {
    let finish: (value: Member) => void = () => undefined
    const client = api((projectId) => (
      projectId === 'p1'
        ? new Promise<Member>((resolve) => { finish = resolve })
        : Promise.resolve(member({ project_id: 'p2', dm_conversation_id: 's-p2' }))
    ))
    const { rerender, result } = renderHook(
      ({ projectId }) => useDmTarget(client, projectId, 'm1', [member({ project_id: projectId })]),
      { initialProps: { projectId: 'p1' } },
    )
    rerender({ projectId: 'p2' })
    await waitFor(() => expect(result.current.member?.dm_conversation_id).toBe('s-p2'))
    await act(async () => finish(member({ dm_conversation_id: 's-p1' })))
    expect(result.current.member?.dm_conversation_id).toBe('s-p2')
  })

  it('reports a conversation that cannot be opened', async () => {
    const onError = vi.fn()
    const client = api(() => Promise.reject(new Error('gone')))
    const { result } = renderHook(() => useDmTarget(client, 'p1', 'm1', [member({})], onError))
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.member).toBeNull()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toEqual(new Error('gone'))
  })

  it('is idle without a member', () => {
    const client = api(() => Promise.reject(new Error('not called')))
    const { result } = renderHook(() => useDmTarget(client, 'p1', null, []))
    expect(result.current).toEqual({ status: 'idle', member: null })
  })
})
