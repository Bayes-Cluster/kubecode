import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { playFlip, useFlipGroup, type FlipRect } from './flip'

/**
 * ADR 0257 §5/§7: FLIP reads before a commit, inverts after it, cancels and
 * retargets an interrupted run, cleans up on unmount, and does nothing (but
 * stays settled) under reduced motion.
 */

interface FakeAnimation {
  cancel: ReturnType<typeof vi.fn>
  finished: Promise<void>
}

let animations: FakeAnimation[] = []

function stubAnimate() {
  animations = []
  HTMLElement.prototype.animate = vi.fn(function (this: HTMLElement, keyframes: Keyframe[]) {
    const animation: FakeAnimation = {
      cancel: vi.fn(),
      finished: Promise.resolve(),
    }
    animations.push(animation)
    void keyframes
    return animation as unknown as Animation
  })
}

const rect = (x: number, y: number): FlipRect => ({ x, y, width: 100, height: 40 })

function List({ keys, measure }: { keys: string[]; measure: (element: Element) => FlipRect }) {
  const register = useFlipGroup(keys, { measure })
  return (
    <ul>
      {keys.map((key) => (
        <li key={key} ref={register(key)} data-testid={key}>
          {key}
        </li>
      ))}
    </ul>
  )
}

describe('playFlip', () => {
  beforeEach(() => {
    stubAnimate()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('animates from the inverted first box to identity', () => {
    const element = document.createElement('div')
    const measure = vi.fn().mockReturnValue(rect(40, 60))
    const first = rect(0, 0)
    const animation = playFlip(element, first, {}, measure)
    expect(animation).not.toBeNull()
    expect(HTMLElement.prototype.animate).toHaveBeenCalledWith(
      [
        expect.objectContaining({ transform: 'translate(-40px, -60px) scale(1, 1)' }),
        expect.objectContaining({ transform: 'none' }),
      ],
      expect.objectContaining({ easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }),
    )
  })

  it('is settled when the element did not move', () => {
    const element = document.createElement('div')
    const measure = vi.fn().mockReturnValue(rect(0, 0))
    expect(playFlip(element, rect(0.5, 0.5), {}, measure)).toBeNull()
    expect(HTMLElement.prototype.animate).not.toHaveBeenCalled()
  })

  it('applies the final state immediately under reduced motion', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }),
    )
    const element = document.createElement('div')
    const measure = vi.fn().mockReturnValue(rect(40, 60))
    expect(playFlip(element, rect(0, 0), {}, measure)).toBeNull()
    expect(HTMLElement.prototype.animate).not.toHaveBeenCalled()
  })
})

describe('useFlipGroup', () => {
  beforeEach(() => {
    stubAnimate()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('animates surviving items from their previous box after a reorder and measures nothing on an unrelated rerender', () => {
    const measure = vi.fn().mockImplementation((element: Element) => rect(0, Number(element.textContent) * 10))
    // The hook keys off the list's identity: one array per list state.
    const initial = ['a', 'b']
    const reordered = ['b', 'a']
    const { rerender } = render(<List keys={initial} measure={measure} />)
    expect(HTMLElement.prototype.animate).not.toHaveBeenCalled()

    rerender(<List keys={reordered} measure={measure} />)
    expect(HTMLElement.prototype.animate).toHaveBeenCalledTimes(2)

    const unrelated = measure.mock.calls.length
    rerender(<List keys={reordered} measure={measure} />)
    expect(measure.mock.calls.length).toBe(unrelated)
    expect(HTMLElement.prototype.animate).toHaveBeenCalledTimes(2)
  })

  it('cancels the previous animation when the list changes again, and cleans up on unmount', () => {
    const measure = vi.fn().mockImplementation((element: Element) => rect(0, Number(element.textContent) * 10))
    const { rerender, unmount } = render(<List keys={['a', 'b']} measure={measure} />)
    rerender(<List keys={['b', 'a']} measure={measure} />)
    expect(animations).toHaveLength(2)

    rerender(<List keys={['a', 'b']} measure={measure} />)
    expect(animations[0].cancel).toHaveBeenCalled()
    expect(animations[1].cancel).toHaveBeenCalled()
    expect(animations).toHaveLength(4)

    const running = animations.slice(2)
    unmount()
    for (const animation of running) expect(animation.cancel).toHaveBeenCalled()
  })

  it('does not animate under reduced motion', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }),
    )
    const measure = vi.fn().mockImplementation((element: Element) => rect(0, Number(element.textContent) * 10))
    const { rerender } = render(<List keys={['a', 'b']} measure={measure} />)
    rerender(<List keys={['b', 'a']} measure={measure} />)
    expect(HTMLElement.prototype.animate).not.toHaveBeenCalled()
  })

  it('keeps items settled when an animation finishes', async () => {
    const measure = vi.fn().mockImplementation((element: Element) => rect(0, Number(element.textContent) * 10))
    const { rerender } = render(<List keys={['a', 'b']} measure={measure} />)
    rerender(<List keys={['b', 'a']} measure={measure} />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(animations.every((animation) => animation.cancel.mock.calls.length === 0)).toBe(true)
  })
})
