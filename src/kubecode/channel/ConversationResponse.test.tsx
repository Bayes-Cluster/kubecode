import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import { ConversationResponse } from './ConversationResponse'

const de = createTranslator('de-DE')

// ADR 0242: a General or DM message body is the official MessageResponse.
describe('ConversationResponse', () => {
  it('names the copy controls of code and tables in the app language', async () => {
    render(
      <ConversationResponse t={de}>
        {'| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```python\nprint(1)\n```'}
      </ConversationResponse>,
    )
    expect(await screen.findByRole('button', { name: 'Code kopieren' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Tabelle kopieren' })).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(/Copy Code|Download/)
    expect(screen.queryByRole('button', { name: /download|herunterladen/i })).not.toBeInTheDocument()
  })

  it('relabels copy controls already on screen when the app language changes', async () => {
    const body = '```python\nprint(1)\n```'
    const { rerender } = render(<ConversationResponse t={createTranslator('en')}>{body}</ConversationResponse>)
    expect(await screen.findByRole('button', { name: 'Copy code' })).toBeInTheDocument()
    rerender(<ConversationResponse t={de}>{body}</ConversationResponse>)
    expect(await screen.findByRole('button', { name: 'Code kopieren' })).toBeInTheDocument()
  })

  it('never fetches an image an agent points at: it shows its description', () => {
    const { container } = render(<ConversationResponse t={de}>{'![loss curve](https://example.com/track.png)'}</ConversationResponse>)
    expect(container.querySelector('img')).toBeNull()
    // The description is the official outline Badge (#278), not a project chip.
    const placeholder = screen.getByText('loss curve')
    expect(placeholder).toHaveAttribute('data-slot', 'badge')
    expect(placeholder).toHaveAttribute('data-variant', 'outline')
    expect(container.querySelector('.kubecode-inert-image')).toBeNull()
  })

  it('keeps emphasis as strong and raw HTML as text', () => {
    const { container } = render(<ConversationResponse t={de}>{'**prune** first <script>x</script>'}</ConversationResponse>)
    expect(container.querySelector('strong')).toHaveTextContent('prune')
    expect(container.querySelector('script')).toBeNull()
  })
})
