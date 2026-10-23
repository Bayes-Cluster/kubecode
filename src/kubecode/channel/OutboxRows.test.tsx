import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import { OutboxRows } from './OutboxRows'
import type { OutboxItem } from './outbox'

const t = createTranslator('en')

const item = (overrides: Partial<OutboxItem<null>>): OutboxItem<null> => ({
  id: 'c1', text: 'keep seeds fixed', payload: null, state: 'failed', failure: 'network down', ...overrides,
})

// ADR 0242: an unsent message is the researcher's own Message, pending, with its actions.
describe('OutboxRows', () => {
  it('shows a sending message as pending and a failed one with Send again, Edit and Discard', () => {
    const onSendAgain = vi.fn()
    const onEdit = vi.fn()
    const onDiscard = vi.fn()
    render(
      <OutboxRows
        items={[item({ id: 'c0', text: 'on its way', state: 'sending', failure: null }), item({})]}
        t={t}
        onDiscard={onDiscard}
        onEdit={onEdit}
        onSendAgain={onSendAgain}
      />,
    )
    const rows = within(screen.getByRole('list', { name: 'Unsent messages' })).getAllByRole('listitem')
    expect(rows[0].querySelector('[data-state="pending"]')).not.toBeNull()
    expect(rows[0]).toHaveTextContent('Sending…')
    expect(within(rows[0]).queryByRole('button')).not.toBeInTheDocument()
    expect(rows[1].querySelector('[data-state="failed"]')).not.toBeNull()
    expect(within(rows[1]).getByRole('alert')).toHaveTextContent('Not sent: network down')
    // The failure is the official Alert, not a handcrafted status span (#257).
    expect(within(rows[1]).getByRole('alert')).toHaveAttribute('data-slot', 'alert')
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Send again' }))
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Edit' }))
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Discard' }))
    expect(onSendAgain).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }))
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onDiscard).toHaveBeenCalledTimes(1)
  })

  it('offers no Edit while the composer holds other words, and nothing at all when empty', () => {
    const { container, rerender } = render(<OutboxRows items={[item({})]} t={t} onDiscard={vi.fn()} onSendAgain={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    rerender(<OutboxRows items={[]} t={t} onDiscard={vi.fn()} onSendAgain={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})
