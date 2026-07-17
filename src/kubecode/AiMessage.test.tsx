import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AiMessage } from '@/components/AiMessage'

describe('AiMessage', () => {
  it('edits a user message inline before regenerating', () => {
    const onEdit = vi.fn()
    render(
      <AiMessage
        actions={[]}
        messageId="run-1"
        onEdit={onEdit}
        response="Original response"
        userMessage="Original prompt"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const editor = screen.getByRole('textbox', { name: 'Edit message' })
    fireEvent.change(editor, { target: { value: 'Updated prompt' } })
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))

    expect(onEdit).toHaveBeenCalledWith('run-1', 'Updated prompt')
  })

  it('offers only copy and edit actions for a user message', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(
      <AiMessage
        actions={[]}
        messageId="run-1"
        onEdit={vi.fn()}
        userMessage="Copy this prompt"
      />,
    )

    const actions = screen.getByTestId('ai-user-message-actions')
    expect(actions).toContainElement(screen.getByRole('button', { name: 'Copy message' }))
    expect(actions).toContainElement(screen.getByRole('button', { name: 'Edit message' }))
    expect(actions.querySelectorAll('button')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Copy message' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Copy this prompt'))
  })

  it('keeps an internally woken teammate response visible without a fake user bubble', () => {
    render(
      <AiMessage
        actions={[]}
        internal
        messageId="team-run-1"
        response="I reviewed the backend and submitted the result."
        userMessage="Kubecode Team mailbox has new updates"
      />,
    )

    expect(screen.getByText('I reviewed the backend and submitted the result.')).toBeInTheDocument()
    expect(screen.queryByText('Kubecode Team mailbox has new updates')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ai-user-message-actions')).not.toBeInTheDocument()
  })
})
