import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import type { NeedsYouEntry } from '../app/location/needsYou'
import { NeedsYouList, type NeedsYouListProps } from './NeedsYouList'

const t = createTranslator('en')

const entry = (key: string, overrides: Partial<NeedsYouEntry> = {}): NeedsYouEntry => ({
  key,
  title: `Title ${key}`,
  reason: { label: 'Question', tone: 'warn' },
  target: { place: { view: 'board' }, focus: key },
  group: 'decision',
  state: 'waiting',
  ...overrides,
})

function list(overrides: Partial<NeedsYouListProps> = {}) {
  const props: NeedsYouListProps = {
    entries: [],
    status: 'ready',
    incomplete: false,
    t,
    onOpenTarget: vi.fn(),
    onRetryLoad: vi.fn(),
    ...overrides,
  }
  const view = render(<NeedsYouList {...props} />)
  return { ...view, props }
}

describe('NeedsYouList', () => {
  it('groups decisions apart from setup, each row one button that opens its context', () => {
    const { props } = list({
      entries: [
        entry('question:d1', { detail: 'In Structured pruning · asked by @analyst' }),
        entry('setup:m2', { group: 'setup', title: 'Writer needs setup', reason: { label: 'Needs setup', tone: 'warn' } }),
      ],
    })
    const decisions = screen.getByRole('list', { name: 'Decisions' })
    const setup = screen.getByRole('list', { name: 'Setup' })
    const row = within(decisions).getByRole('button', { name: /Title question:d1/ })
    expect(row).toHaveTextContent('In Structured pruning · asked by @analyst')
    // The official Item is the row's button itself, not a frame around a handmade one.
    expect(row).toHaveAttribute('data-slot', 'item')
    fireEvent.click(row)
    expect(props.onOpenTarget).toHaveBeenCalledWith({ place: { view: 'board' }, focus: 'question:d1' })
    expect(within(setup).getByRole('button', { name: /Writer needs setup/ })).toBeInTheDocument()
  })

  it('shows six rows, then all of them on request', () => {
    list({ entries: Array.from({ length: 8 }, (_, index) => entry(`question:${index}`)) })
    expect(screen.getAllByRole('button', { name: /^Title/ })).toHaveLength(6)
    fireEvent.click(screen.getByRole('button', { name: 'Show all (8)' }))
    expect(screen.getAllByRole('button', { name: /^Title/ })).toHaveLength(8)
  })

  it('keeps an answered row in place, busy, saying it is being updated', () => {
    list({ entries: [entry('question:d1', { state: 'resolving' })] })
    const row = screen.getByRole('button', { name: /Title question:d1/ })
    expect(row).toHaveAttribute('aria-busy', 'true')
    expect(row).toHaveTextContent('Answer recorded — updating…')
  })

  it('says it is checking, that nothing waits, or that some could not be loaded — never empty on failure', () => {
    const { rerender, props } = list({ status: 'loading' })
    expect(screen.getByText('Checking what needs you…')).toBeInTheDocument()
    rerender(<NeedsYouList {...props} status="ready" />)
    expect(screen.getByText('Nothing is waiting for you.').closest('[data-slot="empty"]')).not.toBeNull()
    rerender(<NeedsYouList {...props} entries={[entry('question:d1')]} status="error" />)
    expect(screen.queryByText('Nothing is waiting for you.')).not.toBeInTheDocument()
    expect(screen.getByText('Some waiting items could not be loaded.').closest('[data-slot="alert"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: /Title question:d1/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(props.onRetryLoad).toHaveBeenCalled()
    rerender(<NeedsYouList {...props} incomplete status="ready" />)
    expect(screen.queryByText('Nothing is waiting for you.')).not.toBeInTheDocument()
    expect(screen.getByText('Some waiting items could not be loaded.')).toBeInTheDocument()
  })

  it('leaves announcing to the shell: the list holds no live region of its own', () => {
    list({ entries: [entry('permission:q1', { title: 'Analyst wants to use pytest' })] })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
