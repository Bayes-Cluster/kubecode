import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ThinkingLoader } from './thinking-loader'

/**
 * ADR 0257 §5/§7: the announcement is event-based (the region's text changes
 * only when the label does), the done state freezes at the label the caller
 * passed, the outgoing label leaves after its animation, and unmount leaves
 * no timers or observers behind.
 */

describe('ThinkingLoader', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('announces its label through a status region', () => {
    render(<ThinkingLoader label="Reading sources" />)
    expect(screen.getByRole('status')).toHaveTextContent('Reading sources')
  })

  it('rolls to a new label and drops the old one after its animation', () => {
    const { container, rerender } = render(<ThinkingLoader label="Reading sources" />)
    rerender(<ThinkingLoader label="Writing response" />)
    const ghosts = container.querySelectorAll('.agx-thinking__label--out')
    expect(ghosts).toHaveLength(1)
    expect(ghosts[0]).toHaveTextContent('Reading sources')
    expect(screen.getByRole('status')).toHaveTextContent('Writing response')

    // The ghost leaves when its out-animation ends.
    fireEvent.animationEnd(ghosts[0])
    expect(container.querySelectorAll('.agx-thinking__label--out')).toHaveLength(0)
  })

  it('drops the ghost even when the animation never ends', () => {
    const { container, rerender } = render(<ThinkingLoader label="Reading sources" />)
    rerender(<ThinkingLoader label="Writing response" />)
    expect(container.querySelectorAll('.agx-thinking__label--out')).toHaveLength(1)
    act(() => {
      vi.advanceTimersByTime(700)
    })
    expect(container.querySelectorAll('.agx-thinking__label--out')).toHaveLength(0)
  })

  it('freezes at the done label the caller passed', () => {
    const { container, rerender } = render(<ThinkingLoader label="Reading sources" />)
    rerender(<ThinkingLoader label="Reading sources" done doneLabel="Thought for 12s" />)
    expect(screen.getByRole('status')).toHaveTextContent('Thought for 12s')
    expect(container.querySelector('.agx-thinking')).toHaveAttribute('data-done')
    expect(container.querySelector('.agx-thinking__label--shine')).toBeNull()
  })

  it('disconnects its ResizeObserver on unmount', () => {
    const disconnect = vi.fn()
    const RealObserver = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect = disconnect
    } as unknown as typeof ResizeObserver
    const { unmount } = render(<ThinkingLoader label="Reading sources" />)
    unmount()
    expect(disconnect).toHaveBeenCalled()
    globalThis.ResizeObserver = RealObserver
  })
})
