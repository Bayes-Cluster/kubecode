import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import { DestinationHeader, DESTINATION_TITLES } from './DestinationHeader'

const t = createTranslator('en')

describe('DestinationHeader', () => {
  it('titles every Workspace destination the same way: a level-2 heading after its glyph', () => {
    for (const destination of Object.keys(DESTINATION_TITLES) as Array<keyof typeof DESTINATION_TITLES>) {
      const { container, unmount } = render(<DestinationHeader destination={destination} t={t} />)
      const header = container.querySelector('header')!
      expect(header).toHaveAttribute('data-destination', destination)
      // ADR 0255: the official Item owns the header; the glyph is its media, the hairline the official Separator.
      expect(header.querySelector('[data-slot="item-media"] svg')).not.toBeNull()
      expect(header.querySelector('[data-slot="item-title"] h2')).toHaveTextContent(t(DESTINATION_TITLES[destination]))
      expect(header.parentElement?.querySelector('[data-slot="separator"]')).not.toBeNull()
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(t(DESTINATION_TITLES[destination]))
      unmount()
    }
  })

  it('names the five destinations as the navigation does', () => {
    expect(Object.keys(DESTINATION_TITLES)).toEqual(['general', 'board', 'resources', 'needs-you', 'members'])
    render(<DestinationHeader actions={<button type="button">Add</button>} description="What waits" destination="needs-you" t={t} />)
    expect(screen.getByRole('heading', { level: 2, name: 'Needs you' })).toBeInTheDocument()
    expect(screen.getByText('What waits')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument()
  })
})
