import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Ticker } from './ticker'

/**
 * ADR 0257 §7: the ticker announces the authoritative value to assistive
 * technology, rolls digit columns on real updates, settles instantly under
 * reduced motion, and leaves no rAF behind on unmount.
 */

let rafSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  // The setup's IntersectionObserver never fires; the ticker must still
  // start for these tests.
  globalThis.IntersectionObserver = class {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe() {
      this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver
  rafSpy = vi.spyOn(window, 'requestAnimationFrame')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Ticker', () => {
  it('renders the formatted value for assistive technology and the rolling columns for sight', () => {
    const { container } = render(<Ticker value={1234.5} locale="en-US" format={{ minimumFractionDigits: 1 }} />)
    const live = container.querySelector('.agx-ticker')
    expect(live).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByText('1,234.5')).toHaveClass('agx-ticker__sr')
    expect(container.querySelectorAll('.agx-ticker__col')).toHaveLength(5)
    expect(container.querySelectorAll('.agx-ticker__static')).toHaveLength(2)
  })

  it('rolls to a new value and leaves no animation frame behind on unmount', async () => {
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame')
    const { rerender, unmount } = render(<Ticker value={10} />)
    await new Promise((resolve) => requestAnimationFrame(resolve))
    rerender(<Ticker value={90} />)
    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(rafSpy).toHaveBeenCalled()
    unmount()
    expect(cancelSpy).toHaveBeenCalled()
  })

  it('settles immediately under reduced motion without scheduling a frame', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }),
    )
    const { container, rerender } = render(<Ticker value={12} />)
    const stack = container.querySelector<HTMLElement>('.agx-ticker__stack')
    expect(stack).not.toBeNull()
    rerender(<Ticker value={18} />)
    const stacks = container.querySelectorAll<HTMLElement>('.agx-ticker__stack')
    // d0 is the ones place: 8 → translateY(-(8/11)*100)%.
    expect(stacks[stacks.length - 1]?.style.transform).toBe('translateY(-72.72727272727273%)')
    expect(rafSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
