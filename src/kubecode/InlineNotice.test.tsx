import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'

import { InlineNotice } from './InlineNotice'

const MESSAGE = 'The complete diagnostic that should not affect workspace width'

function Host() {
  const [error, setError] = useState<string | null>(MESSAGE)
  return error ? <InlineNotice closeLabel="Close" detailsLabel="Details" level="error" message={error} onClose={() => setError(null)} /> : null
}

describe('InlineNotice (ADR 0256)', () => {
  it('is the official Alert: one line until Details opens it, closed by its button', () => {
    render(<Host />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveAttribute('data-slot', 'alert')
    expect(alert).toHaveAttribute('data-level', 'error')
    expect(alert.className).toContain('text-destructive')
    expect(alert.querySelector('[data-slot="alert-description"]')).toHaveTextContent(MESSAGE)
    expect(screen.getByTitle(MESSAGE)).toHaveClass('truncate')

    fireEvent.click(screen.getByRole('button', { name: 'Details', expanded: false }))
    expect(screen.getByRole('button', { name: 'Details', expanded: true })).toBeInTheDocument()
    // Open, the whole text wraps inside the official Collapsible content.
    expect(screen.queryByTitle(MESSAGE)).toBeNull()
    expect(alert.querySelector('[data-slot="collapsible-content"]')).toHaveTextContent(MESSAGE)

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('is a warning without a close button when nothing can dismiss it', () => {
    render(<InlineNotice detailsLabel="Details" level="warning" message="Mode fell back" />)
    expect(screen.getByRole('alert').className).toContain('text-warning-foreground')
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
  })
})
