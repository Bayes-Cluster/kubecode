import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import { RecreatedContextCheckpoint, RevisionNavigator } from './RevisionNavigator'

describe('RevisionNavigator', () => {
  it('groups the revision controls on the official ButtonGroup', () => {
    const onSelect = vi.fn()
    render(<RevisionNavigator activeIndex={1} onSelect={onSelect} t={createTranslator('en')} total={3} />)

    const group = screen.getByRole('group', { name: 'Version 2 / 3' })
    expect(group).toHaveAttribute('data-slot', 'button-group')
    fireEvent.click(screen.getByRole('button', { name: 'Previous revision' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next revision' }))
    expect(onSelect.mock.calls).toEqual([[0], [2]])
  })

  it('disables moving past the first and the latest revision', () => {
    render(<RevisionNavigator activeIndex={0} onSelect={vi.fn()} t={createTranslator('en')} total={1} />)
    expect(screen.getByRole('button', { name: 'Previous revision' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next revision' })).toBeDisabled()
  })

  it('marks a recreated context with an AI Elements checkpoint', () => {
    render(<RecreatedContextCheckpoint label="Context recreated" />)
    const note = screen.getByRole('note')
    expect(note).toHaveTextContent('Context recreated')
    expect(note.querySelector('[data-slot="separator"]')).not.toBeNull()
  })
})
