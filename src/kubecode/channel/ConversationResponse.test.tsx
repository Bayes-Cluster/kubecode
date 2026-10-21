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

  it('never fetches an image an agent points at: it shows its description', () => {
    const { container } = render(<ConversationResponse t={de}>{'![loss curve](https://example.com/track.png)'}</ConversationResponse>)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('.kubecode-inert-image')).toHaveTextContent('loss curve')
  })

  it('keeps emphasis as strong and raw HTML as text', () => {
    const { container } = render(<ConversationResponse t={de}>{'**prune** first <script>x</script>'}</ConversationResponse>)
    expect(container.querySelector('strong')).toHaveTextContent('prune')
    expect(container.querySelector('script')).toBeNull()
  })
})
