import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { KubecodeApi } from '../api'
import { analyst } from './memberFixtures'
import { useMembers } from './useMembers'

describe('useMembers', () => {
  it('reads the live roster by default, and the removed members too when asked', async () => {
    const listMembers = vi.fn().mockResolvedValue({ members: [analyst], general_id: null })
    const api = { listMembers } as unknown as KubecodeApi
    const live = renderHook(() => useMembers(api, 'p1', [], 'live'))
    await waitFor(() => expect(live.result.current.status).toBe('ready'))
    expect(listMembers).toHaveBeenLastCalledWith('p1', false)
    const all = renderHook(() => useMembers(api, 'p1', [], 'live', { includeRemoved: true }))
    await waitFor(() => expect(all.result.current.roster?.members).toEqual([analyst]))
    expect(listMembers).toHaveBeenLastCalledWith('p1', true)
  })
})
