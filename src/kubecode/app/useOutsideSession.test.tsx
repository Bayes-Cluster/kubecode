import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Conversation, KubecodeApi } from '../api'
import { keepsSelection } from './sessionCatalog'
import { useOutsideSession } from './useOutsideSession'

const listed = [{ id: 's1' }] as Conversation[]

describe('useOutsideSession', () => {
  it('reads a Session the list leaves out, and nothing for one it holds', async () => {
    const getSession = vi.fn().mockResolvedValue({ id: 's-member' })
    const api = { getSession } as unknown as KubecodeApi
    const { result, rerender } = renderHook(({ id }) => useOutsideSession(api, 'p1', id, listed, true), {
      initialProps: { id: 's-member' as string | null },
    })
    expect(result.current.pending).toBe(true)
    await waitFor(() => expect(result.current.session).toEqual({ id: 's-member' }))
    rerender({ id: 's1' })
    expect(result.current).toEqual({ session: null, pending: false })
    expect(getSession).toHaveBeenCalledTimes(1)
  })

  it('settles on no Session when there is none', async () => {
    const api = { getSession: vi.fn().mockRejectedValue(new Error('not found')) } as unknown as KubecodeApi
    const { result } = renderHook(() => useOutsideSession(api, 'p1', 'gone', listed, true))
    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(result.current.session).toBeNull()
  })
})

describe('keepsSelection', () => {
  it('keeps a listed or held Session and drops anything else', () => {
    expect(keepsSelection('s1', listed, null)).toBe(true)
    expect(keepsSelection('s-member', listed, 's-member')).toBe(true)
    expect(keepsSelection('gone', listed, 's-member')).toBe(false)
    expect(keepsSelection(null, listed, null)).toBe(false)
  })
})
