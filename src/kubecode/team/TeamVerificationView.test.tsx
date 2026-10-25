import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import type { TeamDiscriminationRound } from '../api'
import { TeamVerificationView } from './TeamVerificationView'

const round = (overrides: Partial<TeamDiscriminationRound>): TeamDiscriminationRound => ({
  created_at: '2026-07-18 10:00:00',
  discriminator_member_id: 'member-3',
  evidence: null,
  id: 'round-1',
  resolved_at: null,
  round: 1,
  status: 'running',
  team_id: 'team-1',
  verdict: null,
  workspace_fingerprint: 'abc',
  ...overrides,
})

describe('TeamVerificationView', () => {
  it('lists verification rounds as official items with a translated status badge', () => {
    render(<TeamVerificationView
      rounds={[
        round({}),
        round({ id: 'round-2', round: 2, status: 'rejected', verdict: 'The parser still fails.' }),
      ]}
      t={createTranslator('en')}
    />)

    const rejected = screen.getByText('The parser still fails.').closest('[data-slot="item"]')
    expect(rejected).not.toBeNull()
    expect(screen.getByText('Rejected')).toHaveAttribute('data-variant', 'destructive')
    expect(screen.getByText('Running')).toHaveAttribute('data-variant', 'info')
  })

  it('renders nothing before the first round', () => {
    const { container } = render(<TeamVerificationView rounds={[]} t={createTranslator('en')} />)
    expect(container).toBeEmptyDOMElement()
  })
})
