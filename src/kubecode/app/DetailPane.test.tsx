import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { DetailPane } from './DetailPane'

function Host({ onEscape = vi.fn() }: { onEscape?: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>open</button>
      {open && (
        <DetailPane label="Task details" onEscape={() => { onEscape(); setOpen(false) }}>
          <input aria-label="note" />
          <button type="button">inside</button>
          <div role="combobox" aria-controls="none" aria-expanded="false" tabIndex={0}>pick</div>
        </DetailPane>
      )}
    </div>
  )
}

describe('DetailPane', () => {
  it('takes focus when it opens and gives it back to what opened it', () => {
    render(<Host />)
    const opener = screen.getByRole('button', { name: 'open' })
    opener.focus()
    fireEvent.click(opener)
    expect(screen.getByRole('complementary', { name: 'Task details' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('button', { name: 'inside' }), { key: 'Escape' })
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
  })

  it('gives focus back to what replaced its opener, by its focus key, when the opener moved (a card that changed column)', () => {
    function Moving() {
      const [open, setOpen] = useState(false)
      const [column, setColumn] = useState<'review' | 'done'>('review')
      const card = (
        <button data-focus-key="card:r1" type="button" onClick={() => setOpen(true)}>Pruning</button>
      )
      return (
        <div>
          <section key="review">{column === 'review' && card}</section>
          <section key="done">{column === 'done' && card}</section>
          {open && (
            <DetailPane label="Task details" onEscape={() => setOpen(false)}>
              <button type="button" onClick={() => setColumn('done')}>accept</button>
            </DetailPane>
          )}
        </div>
      )
    }
    render(<Moving />)
    const opener = screen.getByRole('button', { name: 'Pruning' })
    opener.focus()
    fireEvent.click(opener)
    fireEvent.click(screen.getByRole('button', { name: 'accept' }))
    expect(opener.isConnected).toBe(false)
    fireEvent.keyDown(screen.getByRole('button', { name: 'accept' }), { key: 'Escape' })
    expect(screen.getByRole('button', { name: 'Pruning' })).toHaveFocus()
  })

  it('hands Escape to its host, which decides what one level back is', () => {
    const onEscape = vi.fn()
    render(<Host onEscape={onEscape} />)
    fireEvent.click(screen.getByRole('button', { name: 'open' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'inside' }), { key: 'Escape' })
    expect(onEscape).toHaveBeenCalledTimes(1)
  })

  it('leaves Escape to a field being typed in, a composition, and a combobox', () => {
    const onEscape = vi.fn()
    render(<Host onEscape={onEscape} />)
    fireEvent.click(screen.getByRole('button', { name: 'open' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'note' }), { key: 'Escape' })
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    fireEvent.keyDown(screen.getByRole('button', { name: 'inside' }), { key: 'Escape', isComposing: true })
    expect(onEscape).not.toHaveBeenCalled()
    expect(screen.getByRole('complementary')).toBeInTheDocument()
  })
})
