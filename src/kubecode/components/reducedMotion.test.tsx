import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Shimmer } from '@/components/ai-elements/shimmer'
import { prefersReducedMotion, scrollBehavior } from '@/lib/reducedMotion'

function stubMotionPreference(reduce: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query === '(prefers-reduced-motion: reduce)',
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
}

describe('reduced motion (ADR 0246)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads the preference and picks an instant scroll when motion is reduced', () => {
    stubMotionPreference(true)
    expect(prefersReducedMotion()).toBe(true)
    expect(scrollBehavior()).toBe('auto')
    stubMotionPreference(false)
    expect(prefersReducedMotion()).toBe(false)
    expect(scrollBehavior()).toBe('smooth')
  })

  it('treats a browser without matchMedia as allowing motion', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(prefersReducedMotion()).toBe(false)
  })

  it('shows the Shimmer as still text when motion is reduced', () => {
    stubMotionPreference(true)
    render(<Shimmer>Working</Shimmer>)
    const text = screen.getByText('Working')
    expect(text).toHaveAttribute('data-reduced-motion', 'true')
    expect(text.className).not.toContain('text-transparent')
  })

  it('animates the Shimmer otherwise', () => {
    stubMotionPreference(false)
    render(<Shimmer>Working</Shimmer>)
    expect(screen.getByText('Working').className).toContain('text-transparent')
  })
})
