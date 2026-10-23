import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import { DeleteTeamDialog } from './DeleteTeamDialog'

describe('DeleteTeamDialog', () => {
  it('confirms in an AlertDialog and holds it open while the Team is deleted', async () => {
    let finish: () => void = () => undefined
    const onConfirm = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const onOpenChange = vi.fn()
    render(
      <DeleteTeamDialog
        open
        t={createTranslator('en')}
        teamName="Pruning"
        teammateCount={2}
        onConfirm={onConfirm}
        onOpenChange={onOpenChange}
      />,
    )

    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveAttribute('data-slot', 'alert-dialog-content')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onOpenChange).not.toHaveBeenCalled()
    finish()
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled())
  })
})
