import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { DetailPane } from './DetailPane'

function Host({ onClose = vi.fn() }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>open</button>
      {open && (
        <DetailPane label="Task details" onClose={() => { onClose(); setOpen(false) }}>
          <input aria-label="note" />
          <button type="button">inside</button>
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

  it('leaves Escape to a field being typed in', () => {
    const onClose = vi.fn()
    render(<Host onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'open' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'note' }), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('complementary')).toBeInTheDocument()
  })
})
