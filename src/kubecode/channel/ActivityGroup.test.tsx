import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ActivityGroup } from './ActivityGroup'
import { revealActivity } from './activityReveal'
import type { ChannelMessage } from '../api'

const t = ((key: string, values?: Record<string, unknown>) => (key === 'kubecode.channel.activityGroup' ? `Activity (${values?.count})` : key)) as never

const note = (seq: number): ChannelMessage => ({
  id: `m${seq}`, seq, body: `routed ${seq}`, created_at: '2025-01-02T10:00:00Z', author_kind: 'system', kind: 'system',
} as unknown as ChannelMessage)

describe('ActivityGroup (#257)', () => {
  it('is the official Collapsible, closed, with every note kept for anchors', () => {
    render(<ActivityGroup dateLocale="en-US" messages={[note(1), note(2)]} t={t} />)
    const trigger = screen.getByRole('button', { name: 'Activity (2)' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger.closest('[data-slot="collapsible"]')).not.toBeNull()
    // Closed, the notes are still in the document so a link can land on one.
    expect(document.getElementById('message-m2')).not.toBeNull()
    expect(screen.queryByText('routed 2')).not.toBeVisible()
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('routed 2')).toBeVisible()
  })

  it('opens when a jump lands on one of its notes', () => {
    render(<ActivityGroup dateLocale="en-US" messages={[note(1), note(2)]} t={t} />)
    revealActivity(document.getElementById('message-m2') as HTMLElement)
    expect(screen.getByRole('button', { name: 'Activity (2)' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('routed 2')).toBeVisible()
  })
})
