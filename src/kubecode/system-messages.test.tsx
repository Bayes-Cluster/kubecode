import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Button } from '@/components/ui/button'

import { SystemMessageProvider } from './system-messages'
import { useSystemMessages } from './systemMessages'

function MessagePublisher() {
  const messages = useSystemMessages()
  return (
    <Button onClick={() => messages?.publish({
      level: 'error',
      message: 'The complete diagnostic that should not affect workspace width',
      source: 'Changes',
    })}>
      Publish
    </Button>
  )
}

describe('SystemMessageProvider', () => {
  it('publishes an application message as one official toast that can be closed', async () => {
    render(
      <SystemMessageProvider closeLabel="Close" regionLabel="Notifications">
        <MessagePublisher />
      </SystemMessageProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    const message = await screen.findByText('The complete diagnostic that should not affect workspace width')
    const toast = message.closest('[data-sonner-toast]') as HTMLElement
    expect(toast).not.toBeNull()
    expect(toast).toHaveAttribute('data-type', 'error')
    expect(toast).toHaveTextContent('Changes')
    // The same message twice is one toast; the region is named for assistive technology.
    expect(document.querySelectorAll('[data-sonner-toast]')).toHaveLength(1)
    expect(toast.closest('section')).toHaveAttribute('aria-label', expect.stringContaining('Notifications'))

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByText('The complete diagnostic that should not affect workspace width')).not.toBeInTheDocument())
  })
})
