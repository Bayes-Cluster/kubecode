import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import { analyst, managerDecision, permissionItem, proposalItem, questionItem, snapshot } from './attentionFixtures'
import { needsYouFromAttention } from './attentionTargets'
import { NeedsYouView } from './NeedsYouView'

const t = createTranslator('en')

function view(overrides: Partial<Parameters<typeof NeedsYouView>[0]> = {}) {
  const onOpenTarget = vi.fn()
  const onRetryLoad = vi.fn()
  render(
    <NeedsYouView
      entries={[]}
      incomplete={false}
      status="ready"
      t={t}
      onOpenTarget={onOpenTarget}
      onRetryLoad={onRetryLoad}
      {...overrides}
    />,
  )
  return { onOpenTarget, onRetryLoad }
}

describe('NeedsYouView', () => {
  it('is a Workspace destination with the same header as the others', () => {
    view()
    const region = screen.getByRole('region', { name: 'Needs you' })
    const header = region.querySelector('header.kubecode-destination-header')
    expect(header).toHaveAttribute('data-destination', 'needs-you')
    expect(within(region).getByRole('heading', { level: 2, name: 'Needs you' })).toBeInTheDocument()
  })

  it('lists each decision once and opens it where it is answered', () => {
    const entries = needsYouFromAttention(
      snapshot({ items: [permissionItem(), questionItem(), proposalItem()] }),
      new Set(),
      t,
      { presentation: 'screen' },
    )
    const { onOpenTarget } = view({ entries })
    const decisions = screen.getByRole('list', { name: 'Decisions' })
    expect(within(decisions).getAllByRole('button')).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: /Run pytest/ }))
    expect(onOpenTarget).toHaveBeenLastCalledWith({ place: { view: 'general' }, focus: 'permission:q1' })
    fireEvent.click(screen.getByRole('button', { name: /Which ratios/ }))
    expect(onOpenTarget).toHaveBeenLastCalledWith({
      place: { view: 'board' }, inspect: { kind: 'task', id: 'r1' }, focus: 'question:d1',
    })
  })

  it('shows every entry at once: the view has the room the navigation had not', () => {
    const one = needsYouFromAttention(snapshot({ items: [permissionItem()] }), new Set(), t, { presentation: 'screen' })[0]
    const entries = Array.from({ length: 9 }, (_, index) => ({ ...one, key: `k${index}`, title: `Decision ${index}` }))
    view({ entries })
    expect(screen.getAllByRole('button', { name: /^Decision \d/ })).toHaveLength(9)
    expect(screen.queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument()
  })

  it('says nothing is waiting only when the list is complete, and offers a retry otherwise', () => {
    const { onRetryLoad } = view({ incomplete: true })
    expect(screen.queryByText('Nothing is waiting for you.')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetryLoad).toHaveBeenCalled()
  })

  it('shows what the project manager decided as information, not as something to answer', () => {
    view({
      managerDecisions: [
        managerDecision(),
        managerDecision({ id: 'md2', request_id: 'q2', decision: 'escalated', member: null, reason: 'Deletes data.' }),
      ],
    })
    const list = screen.getByRole('list', { name: 'Decided by the project manager' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Approved')
    expect(rows[0]).toHaveTextContent(`${analyst.name} asked to use Run pytest -q`)
    expect(rows[0]).toHaveTextContent('Reason: Tests only read the workspace.')
    expect(rows[1]).toHaveTextContent('Escalated to you')
    expect(rows[1]).toHaveTextContent('A specialist asked to use Run pytest -q')
    expect(within(list).queryByRole('button')).not.toBeInTheDocument()
  })

  it('words a request the server escalated by itself, not the manager', () => {
    view({ managerDecisions: [managerDecision({ decision: 'escalated', decided_by: 'system', reason: 'timeout' })] })
    const row = within(screen.getByRole('list', { name: 'Decided by the project manager' })).getByRole('listitem')
    expect(row).toHaveTextContent('Reason: The project manager did not decide in time.')
    expect(row).toHaveTextContent('Escalated to you')
  })

  it('shows no manager decisions section when there are none', () => {
    view()
    expect(screen.queryByRole('list', { name: 'Decided by the project manager' })).not.toBeInTheDocument()
  })
})
