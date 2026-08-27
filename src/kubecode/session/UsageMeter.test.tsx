import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { parseUsage, usageLevel } from './sessionModel'
import { UsageMeter } from './UsageMeter'

const t = (key: string, values?: Record<string, string | number>) => {
  if (!values) return key
  if (key === 'kubecode.usageOfWindow') {
    return `${values.used} of ${values.total} tokens (${values.percent}%)`
  }
  if (key === 'kubecode.usageTokensOnly') return `${values.count} tokens in context`
  return `${key}:${JSON.stringify(values)}`
}

describe('parseUsage', () => {
  it('reads the ACP checkpoint shape and tolerates unknown windows', () => {
    expect(parseUsage({ used: 1234, size: 8000 })).toEqual({
      used: 1234,
      size: 8000,
      cost: null,
    })
    expect(parseUsage({ used: 50, size: 0, cost: { amount: 1.5, currency: 'USD' } })).toEqual({
      used: 50,
      size: 0,
      cost: 'USD 1.50',
    })
    expect(parseUsage({ used: 'many' })).toEqual({ used: null, size: null, cost: null })
    expect(parseUsage(null)).toBeNull()
    expect(parseUsage('nope')).toBeNull()
  })
})

describe('usageLevel thresholds', () => {
  it('flags amber above 75% and red above 90%', () => {
    expect(usageLevel(10, 100)).toBe('ok')
    expect(usageLevel(76, 100)).toBe('warning')
    expect(usageLevel(91, 100)).toBe('danger')
    expect(usageLevel(100, 0)).toBe('ok')
  })
})

describe('UsageMeter', () => {
  it('renders the gauge with a threshold bar when the window is known', async () => {
    render(<UsageMeter locale="en-US" t={t as never} usage={{ used: 1234, size: 8000 }} />)
    expect(screen.getByTestId('usage-meter-value')).toHaveTextContent('15%')
    fireEvent.click(screen.getByTestId('usage-meter-trigger'))
    const popover = screen.getByTestId('usage-meter-popover')
    expect(popover).toBeInTheDocument()
    expect(popover).toHaveTextContent('1,234 of 8,000 tokens (15%)')
    expect(screen.getByTestId('usage-meter-bar')).toHaveStyle({ width: '15%' })
  })

  it('falls back to counts-only when the window size is unknown', async () => {
    render(<UsageMeter locale="en-US" t={t as never} usage={{ used: 4321 }} />)
    expect(screen.getByTestId('usage-meter-value')).toHaveTextContent('4.3K')
    fireEvent.click(screen.getByTestId('usage-meter-trigger'))
    expect(screen.getByTestId('usage-meter-detail')).toHaveTextContent('4,321')
    expect(screen.queryByTestId('usage-meter-bar')).not.toBeInTheDocument()
  })

  it('renders nothing without usage', () => {
    render(<UsageMeter locale="en-US" t={t as never} usage={null} />)
    expect(screen.queryByTestId('usage-meter-trigger')).not.toBeInTheDocument()
  })
})
