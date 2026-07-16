import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Button } from '@/components/ui/button'

import { SystemMessageProvider } from './SystemMessageNotice'
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
  it('publishes expandable and dismissible application messages', () => {
    render(
      <SystemMessageProvider dismissLabel="Close">
        <MessagePublisher />
      </SystemMessageProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Changes')
    expect(alert).toHaveTextContent('The complete diagnostic')

    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
