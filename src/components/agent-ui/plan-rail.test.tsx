import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { PlanRail, type PlanRailEntry } from './plan-rail'

/**
 * ADR 0257 §7: the rail renders the three markers, says each status in
 * words, and keeps unknown priorities out of the way. The read model
 * replaces as a whole — no per-row motion is claimed or tested.
 */

const LABELS = { completed: 'Completed', in_progress: 'In progress', pending: 'Pending' }

const ENTRIES: PlanRailEntry[] = [
  { content: 'Survey the tree', status: 'completed' },
  { content: 'Prune the heads', status: 'in_progress' },
  { content: 'Write the summary', status: 'pending' },
]

describe('PlanRail', () => {
  it('renders one marked row per entry, with the status said in words', () => {
    const { container } = render(<PlanRail aria-label="Plan" entries={ENTRIES} statusLabels={LABELS} />)
    const rows = container.querySelectorAll('.agx-plan__row')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveAttribute('data-status', 'completed')
    expect(rows[1]).toHaveAttribute('data-status', 'in_progress')
    expect(rows[2]).toHaveAttribute('data-status', 'pending')
    expect(rows[0].querySelector('.sr-only')).toHaveTextContent('Completed:')
    expect(rows[1].querySelector('.sr-only')).toHaveTextContent('In progress:')
    expect(rows[1]).toHaveTextContent('Prune the heads')
    // The drawn markers are decorative; the words carry the meaning.
    expect(container.querySelector('.agx-plan__marker')).toHaveAttribute('aria-hidden', 'true')
  })
})
