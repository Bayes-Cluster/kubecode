import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AiActionCard } from '@/components/AiActionCard'
import { translate } from '@/lib/i18n'

/**
 * ADR 0257, slice E2: a tool card's glyph eases in as the state changes,
 * and the output block carries its own copy acknowledgment with a
 * localized name.
 */

const t = (key: Parameters<typeof translate>[1]) => translate('en-US', key)

describe('the session tool card (slice E2 presentation)', () => {
  it('eases the status glyph in when the state changes and keeps the state in words', () => {
    const { rerender } = render(
      <AiActionCard
        expanded={false}
        label="Read file"
        locale="en-US"
        status="pending"
        tool="read_file"
        onToggle={() => undefined}
      />,
    )
    const badge = screen.getByText(t('kubecode.session.toolStatusRunning')).closest('[data-slot="badge"]') as HTMLElement
    const glyph = badge?.firstElementChild as HTMLElement
    expect(glyph.className).toContain('animate-in')
    expect(glyph.className).toContain('zoom-in-90')

    rerender(
      <AiActionCard
        expanded={false}
        label="Read file"
        locale="en-US"
        status="done"
        tool="read_file"
        onToggle={() => undefined}
      />,
    )
    expect(screen.getByText(t('kubecode.session.toolStatusDone'))).toBeInTheDocument()
  })

  it('gives the output block a localized copy action', () => {
    render(
      <AiActionCard
        expanded
        label="Read file"
        locale="en-US"
        output="pruned,0.91"
        status="done"
        tool="read_file"
        onToggle={() => undefined}
      />,
    )
    expect(screen.getByRole('button', { name: t('kubecode.channel.copyText') })).toBeInTheDocument()
    expect(screen.getByText('pruned,0.91')).toBeInTheDocument()
  })
})
