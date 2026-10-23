import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ReferenceChip } from './ReferenceChip'

describe('ReferenceChip', () => {
  it('is the official Attachment, opened by a trigger named by its kind, title, version and state', () => {
    const onOpen = vi.fn()
    const { container } = render(
      <ReferenceChip
        kind="evidence"
        kindLabel="Evidence"
        state={{ kind: 'changed', label: 'Changed since' }}
        title="results.csv"
        version="v3"
        onOpen={onOpen}
      />,
    )
    const chip = container.querySelector('[data-slot="attachment"]')
    expect(chip).toHaveAttribute('data-reference-state', 'changed')
    fireEvent.click(screen.getByRole('button', { name: 'Evidence results.csv v3 Changed since' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Changed since')).toHaveAttribute('data-slot', 'badge')
  })

  it('removes from a draft through its own action', () => {
    const onRemove = vi.fn()
    render(<ReferenceChip kind="finding" kindLabel="Finding" removeLabel="Remove Heads" title="Heads" onRemove={onRemove} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Heads' }))
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /^Finding/ })).not.toBeInTheDocument()
  })

  it('marks a removed record as an error and never opens an unavailable one', () => {
    const { container, rerender } = render(
      <ReferenceChip kind="finding" kindLabel="Finding" state={{ kind: 'removed', label: 'No longer exists' }} title="Heads" onOpen={vi.fn()} />,
    )
    expect(container.querySelector('[data-slot="attachment"]')).toHaveAttribute('data-state', 'error')
    rerender(<ReferenceChip kind="finding" kindLabel="Finding" state={{ kind: 'unavailable', label: 'Not available here' }} title="Heads" onOpen={vi.fn()} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByText('Not available here')).toBeInTheDocument()
  })
})
