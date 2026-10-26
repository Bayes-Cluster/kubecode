import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BlurSwap } from './blur-swap'

/**
 * ADR 0257 §7: a swap keeps the outgoing content only while it animates out,
 * bounds the container for the morph, settles when the run ends, and swaps
 * immediately under reduced motion.
 */

describe('BlurSwap', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps the outgoing layer for the morph and removes it after settling', () => {
    const { container, rerender } = render(
      <BlurSwap swapKey={1} duration={420}>
        <p>first</p>
      </BlurSwap>,
    )
    rerender(
      <BlurSwap swapKey={2} duration={420}>
        <p>second</p>
      </BlurSwap>,
    )
    const containerDiv = container.querySelector('.agx-blur') as HTMLElement
    expect(containerDiv).toHaveAttribute('data-busy')
    expect(containerDiv.style.height).toContain('px')
    const out = container.querySelectorAll('.agx-blur__layer--out')
    expect(out).toHaveLength(1)
    expect(out[0]).toHaveTextContent('first')
    expect(out[0]).toHaveAttribute('aria-hidden')

    act(() => {
      vi.advanceTimersByTime(450)
    })
    expect(container.querySelectorAll('.agx-blur__layer--out')).toHaveLength(0)
    expect(containerDiv).not.toHaveAttribute('data-busy')
    expect(containerDiv.style.height).toBe('')
  })

  it('swaps immediately under reduced motion', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }),
    )
    const { container, rerender } = render(
      <BlurSwap swapKey={1}>
        <p>first</p>
      </BlurSwap>,
    )
    rerender(
      <BlurSwap swapKey={2}>
        <p>second</p>
      </BlurSwap>,
    )
    const containerDiv = container.querySelector('.agx-blur') as HTMLElement
    expect(containerDiv).not.toHaveAttribute('data-busy')
    expect(container.querySelectorAll('.agx-blur__layer--out')).toHaveLength(0)
    expect(container.querySelector('.agx-blur__layer--in')).toHaveTextContent('second')
  })

  it('cancels the settle timer on unmount', () => {
    const { rerender, unmount } = render(
      <BlurSwap swapKey={1}>
        <p>first</p>
      </BlurSwap>,
    )
    rerender(
      <BlurSwap swapKey={2}>
        <p>second</p>
      </BlurSwap>,
    )
    expect(() => unmount()).not.toThrow()
    vi.advanceTimersByTime(1000)
  })
})
