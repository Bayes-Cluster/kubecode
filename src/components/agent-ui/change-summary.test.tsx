import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AgxChangeSummaryRow } from './change-summary'

/**
 * ADR 0257 §7: the row presents the adapter's own tally — the tone on the
 * tinted square, the label truncating under its title, the count said for
 * everyone. Nothing here stages, reverts or diffs.
 */

describe('AgxChangeSummaryRow', () => {
  it('names the group, says the count, and draws the tone mark for those who see it', () => {
    render(
      <AgxChangeSummaryRow
        count={2}
        data-testid="row"
        icon={<svg data-testid="mark" viewBox="0 0 16 16" />}
        label="Staged"
        tone="info"
      />,
    )
    expect(screen.getByTestId('row')).toHaveAttribute('data-tone', 'info')
    expect(screen.getByText('Staged')).toHaveClass('agx-csum__label')
    expect(screen.getByText('2')).toHaveClass('agx-csum__count')
    const mark = screen.getByTestId('mark').closest('.agx-csum__mark') as HTMLElement
    expect(mark).toHaveAttribute('aria-hidden', 'true')
  })

  it('renders without the mark and with a plain count when the host keeps it quiet', () => {
    render(<AgxChangeSummaryRow count="3+" label="Changes" tone="bad" />)
    expect(screen.getByText('Changes').closest('.agx-csum__row')).toHaveAttribute('data-tone', 'bad')
    expect(screen.getByText('3+')).toHaveClass('agx-csum__count')
    expect(document.querySelector('.agx-csum__mark')).toBeNull()
  })
})
