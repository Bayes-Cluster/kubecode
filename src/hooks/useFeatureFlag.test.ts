import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useFeatureFlag } from './useFeatureFlag'

describe('useFeatureFlag', () => {
  it('returns false for example_flag by default', () => {
    vi.spyOn(globalThis, 'localStorage', 'get').mockReturnValue({
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      length: 0,
      key: () => null,
    })
    const { result } = renderHook(() => useFeatureFlag('example_flag'))
    expect(result.current).toBe(false)
    vi.restoreAllMocks()
  })

  it('returns true when localStorage override is set to "true"', () => {
    vi.spyOn(globalThis, 'localStorage', 'get').mockReturnValue({
      getItem: (key: string) => key === 'ff_example_flag' ? 'true' : null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      length: 0,
      key: () => null,
    })
    const { result } = renderHook(() => useFeatureFlag('example_flag'))
    expect(result.current).toBe(true)
    vi.restoreAllMocks()
  })

  it('returns false when localStorage override is set to "false"', () => {
    vi.spyOn(globalThis, 'localStorage', 'get').mockReturnValue({
      getItem: (key: string) => key === 'ff_example_flag' ? 'false' : null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      length: 0,
      key: () => null,
    })
    const { result } = renderHook(() => useFeatureFlag('example_flag'))
    expect(result.current).toBe(false)
    vi.restoreAllMocks()
  })

  it('ignores non-boolean localStorage values (treats as false)', () => {
    vi.spyOn(globalThis, 'localStorage', 'get').mockReturnValue({
      getItem: (key: string) => key === 'ff_example_flag' ? 'maybe' : null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      length: 0,
      key: () => null,
    })
    const { result } = renderHook(() => useFeatureFlag('example_flag'))
    expect(result.current).toBe(false)
    vi.restoreAllMocks()
  })

  it('falls back to default when localStorage throws', () => {
    vi.spyOn(globalThis, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('localStorage disabled')
    })
    const { result } = renderHook(() => useFeatureFlag('example_flag'))
    expect(result.current).toBe(false)
    vi.restoreAllMocks()
  })
})
