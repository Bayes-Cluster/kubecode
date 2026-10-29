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
})
