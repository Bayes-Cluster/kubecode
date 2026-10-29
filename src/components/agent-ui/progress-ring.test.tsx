import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AgxProgressRing } from './progress-ring'

/**
 * ADR 0257 §7: the ring presents the adapter's own count — one segment per
 * unit until twelve, one proportional arc past that, the tally said to
 * assistive tech and drawn in the middle. Nothing here invents a unit.
 */

describe('AgxProgressRing', () => {
  it('says the tally politely and draws one segment per unit while few', () => {
    render(<AgxProgressRing done={3} label="3 of 5 work items done" total={5} />)
    expect(screen.getByRole('img', { name: '3 of 5 work items done' })).toHaveTextContent('3/5')
    expect(document.querySelectorAll('.agx-ring__seg')).toHaveLength(5)
    expect(document.querySelectorAll('.agx-ring__seg[data-done]')).toHaveLength(3)
  })

  it('draws one proportional arc past twelve units', () => {
    render(<AgxProgressRing done={9} label="9 of 20 work items done" total={20} />)
    expect(screen.getByRole('img', { name: '9 of 20 work items done' })).toHaveTextContent('45%')
    expect(document.querySelectorAll('.agx-ring__seg')).toHaveLength(24)
  })

  it('clamps a done count that outruns the total', () => {
    render(<AgxProgressRing done={9} label="5 of 5 work items done" total={5} />)
    expect(screen.getByRole('img', { name: '5 of 5 work items done' })).toHaveTextContent('5/5')
    expect(document.querySelectorAll('.agx-ring__seg[data-done]')).toHaveLength(5)
  })

  it('places the first segment at the ring top and closes the last at the wrap', () => {
    render(<AgxProgressRing done={2} label="2 of 4 work items done" total={4} />)
    const segments = document.querySelectorAll('.agx-ring__seg')
    const circumference = 2 * Math.PI * 13
    // Segment 0 starts at the rotated top, shifted half a gap...
    expect(segments[0].getAttribute('stroke-dashoffset')).toBe('-2.5')
    // ...and the last segment ends the arc at the wrap point.
    const last = segments[segments.length - 1]
    const span = circumference / 4 - 5
    expect(Number(last.getAttribute('stroke-dashoffset'))).toBeCloseTo(-(3 * (circumference / 4) + 5 / 2), 5)
    expect(last.getAttribute('stroke-dasharray')).toBe(`${span} ${circumference}`)
  })

  it('draws nothing when the adapter has no units', () => {
    const { container } = render(<AgxProgressRing done={0} label="0 of 0 work items done" total={0} />)
    expect(container).toBeEmptyDOMElement()
  })
})
