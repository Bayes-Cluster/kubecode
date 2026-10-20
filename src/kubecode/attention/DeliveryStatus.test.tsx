import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import type { MessageDelivery } from '../api'
import { analyst, manager, messageDelivery, routeDelivery } from './attentionFixtures'
import { DeliveryActionsContext, type DeliveryActions } from './deliveryContext'
import { DeliveryStatus } from './DeliveryStatus'

const t = createTranslator('en')

function show(delivery: MessageDelivery, { actions = {}, latest = true, notes = [] }: {
  actions?: Partial<DeliveryActions>
  latest?: boolean
  notes?: string[]
} = {}) {
  const value: DeliveryActions = {
    retry: vi.fn(),
    reroute: vi.fn(),
    busy: new Set(),
    refusals: new Map(),
    openMembers: vi.fn(),
    copyToComposer: vi.fn(),
    ...actions,
  }
  render(
    <DeliveryActionsContext.Provider value={value}>
      <DeliveryStatus body="Prune the heads" delivery={delivery} latest={latest} notes={notes} t={t} />
    </DeliveryActionsContext.Provider>,
  )
  return value
}

describe('DeliveryStatus', () => {
  it('says only what the server proved: saved, sending, busy, retrying, queued', () => {
    const cases: Array<[MessageDelivery, string]> = [
      [messageDelivery({ state: 'saved', routes: [] }), 'Saved'],
      [messageDelivery({ state: 'sending', routes: [routeDelivery({ state: 'sending', recipient: manager })] }), 'Sending to General Agent…'],
      [messageDelivery({ state: 'sending', routes: [routeDelivery({ state: 'busy', busy: 2 })] }), 'Analyst is busy; it will get this when free'],
      [messageDelivery({ state: 'sending', routes: [routeDelivery({ state: 'retrying', attempts: 3 })] }), 'Still trying to reach Analyst (3 attempts)'],
      [messageDelivery({ state: 'sending', routes: [routeDelivery({ state: 'retrying', attempts: 1 })] }), 'Still trying to reach Analyst (1 attempt)'],
      [messageDelivery({ routes: [routeDelivery({ state: 'queued' })] }), 'Queued for Analyst'],
      [messageDelivery({ routes: [routeDelivery({ state: 'withdrawn' })] }), "Removed from Analyst's queue before it started"],
    ]
    for (const [delivery, text] of cases) {
      const { unmount } = render(<DeliveryStatus body="" delivery={delivery} latest notes={[]} t={t} />)
      expect(screen.getByText(text)).toBeInTheDocument()
      unmount()
    }
  })

  it('says Delivered only under the latest of the researcher\'s messages, and what it means', () => {
    const delivery = messageDelivery({ routes: [routeDelivery(), routeDelivery({ route_id: 'r2', recipient: manager })] })
    const { unmount } = render(<DeliveryStatus body="" delivery={delivery} latest notes={[]} t={t} />)
    const line = screen.getByText('Delivered to Analyst and General Agent')
    expect(line).toHaveAttribute('title', 'Delivered means they have it, not that they have read or acted on it')
    unmount()
    const { container } = render(<DeliveryStatus body="" delivery={delivery} latest={false} notes={[]} t={t} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('says to whom a message was not delivered, retries it by name, and keeps the details', () => {
    const delivery = messageDelivery({
      state: 'partial',
      routes: [
        routeDelivery({ route_id: 'ok' }),
        routeDelivery({ route_id: 'bad', state: 'failed', retryable: true, recipient: { ...analyst, id: 'w', name: 'Writer', handle: 'writer' }, last_error: 'the Session stayed busy' }),
      ],
    })
    const actions = show(delivery, { notes: ['Kubecode: not delivered to @writer'] })
    const failure = screen.getByRole('status')
    expect(failure).toHaveTextContent('Not delivered to Writer')
    fireEvent.click(screen.getByRole('button', { name: 'Retry delivery to Writer' }))
    expect(actions.retry).toHaveBeenCalledWith('bad', 'msg1')
    const details = screen.getByText('Details').closest('details') as HTMLElement
    expect(within(details).getByText('the Session stayed busy')).toBeInTheDocument()
    expect(within(details).getByText('Kubecode: not delivered to @writer')).toBeInTheDocument()
  })

  it('offers the text back when the recipient\'s Session is gone, and says when retries ran out', () => {
    const delivery = messageDelivery({ state: 'failed', routes: [routeDelivery({ route_id: 'bad', state: 'failed', retryable: true })] })
    const actions = show(delivery, { actions: { refusals: new Map([['bad', 'gone' as const]]) } })
    expect(screen.getByText("Analyst's Session no longer exists.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Copy to message box' }))
    expect(actions.copyToComposer).toHaveBeenCalledWith('Prune the heads')
  })

  it('names why a message reached nobody, and offers Members and Try again', () => {
    const delivery = messageDelivery({ state: 'denied', routes: [], denial: { code: 'manager_unavailable', reroutable: true, note_id: 'n1' } })
    const actions = show(delivery)
    expect(screen.getByText('Not delivered: the project manager is not set up yet')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open Members' }))
    expect(actions.openMembers).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(actions.reroute).toHaveBeenCalledWith('msg1')
  })

  it('says when retries ran out without sending the researcher to a Settings page that has no Members', () => {
    const delivery = messageDelivery({ state: 'failed', routes: [routeDelivery({ route_id: 'bad', state: 'failed', retryable: true })] })
    show(delivery, { actions: { refusals: new Map([['bad', 'limit' as const]]) } })
    expect(screen.getByText('Retried too many times. Check the member in Members, then send the message again.')).toBeInTheDocument()
    expect(screen.queryByText(/Settings/)).not.toBeInTheDocument()
  })

  it('says a member needs setup, keeps Retry for after the fix, and opens Members', () => {
    const delivery = messageDelivery({ state: 'failed', routes: [routeDelivery({ route_id: 'bad', state: 'failed', retryable: true })] })
    const actions = show(delivery, { actions: { refusals: new Map([['bad', 'needsSetup' as const]]) } })
    expect(screen.getByText('Analyst needs setup. Fix it in Members, then retry.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry delivery to Analyst' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open Members' }))
    expect(actions.openMembers).toHaveBeenCalled()
  })

  it('tells a reroute that failed to reach the server apart from one that was refused', () => {
    const denied = messageDelivery({ state: 'denied', routes: [], denial: { code: 'member_unavailable', reroutable: true, note_id: null } })
    const { unmount } = render(
      <DeliveryActionsContext.Provider value={{ retry: vi.fn(), reroute: vi.fn(), busy: new Set(), refusals: new Map([['msg1', 'failed' as const]]), openMembers: vi.fn(), copyToComposer: vi.fn() }}>
        <DeliveryStatus body="" delivery={denied} latest notes={[]} t={t} />
      </DeliveryActionsContext.Provider>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('The retry could not be started. Try again.')
    expect(screen.queryByText('This delivery cannot be retried.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    unmount()
    show(denied, { actions: { refusals: new Map([['msg1', 'notRetryable' as const]]) } })
    expect(screen.getByText('This delivery cannot be retried.')).toBeInTheDocument()
  })

  it('keeps a retry busy while it is asked for', () => {
    const delivery = messageDelivery({ state: 'failed', routes: [routeDelivery({ route_id: 'bad', state: 'failed', retryable: true })] })
    show(delivery, { actions: { busy: new Set(['bad']) } })
    expect(screen.getByRole('button', { name: 'Retry delivery to Analyst' })).toHaveAttribute('aria-busy', 'true')
  })
})
