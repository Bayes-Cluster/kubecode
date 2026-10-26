import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import type { KubecodeApi, ProjectContextRef } from '../api'
import { ReferenceResolverProvider } from './ReferenceResolverProvider'
import { ReferenceSources } from './ReferenceSources'

const t = createTranslator('en')

const summary = { kind: 'file' as const, id: 'results/summary.csv', revision: '3f2c1a9e5b7d4c6a' }
const notes = { kind: 'file' as const, id: 'notes.md', revision: 'aaaaaaaaaaaaaaaa' }

function mount(availability: Record<string, string>, extra: { leading?: boolean } = {}) {
  const resolveProjectContext = vi.fn().mockImplementation((_p: string, refs: ProjectContextRef[]) => Promise.resolve(
    refs.map((ref) => ({ ref, availability: availability[ref.id] ?? 'available', current_revision: 'cccccccccccccccc', title: ref.id })),
  ))
  const onOpen = vi.fn()
  const view = render(
    <ReferenceResolverProvider api={{ resolveProjectContext } as unknown as KubecodeApi} events={[]} projectId="p1">
      <ReferenceSources
        leading={extra.leading ? <span>Task chip</span> : undefined}
        references={[{ ref: summary, title: 'Summary' }, { ref: notes }]}
        t={t}
        onOpen={onOpen}
      />
    </ReferenceResolverProvider>,
  )
  return { ...view, onOpen }
}

describe('ReferenceSources', () => {
  it('lists cited materials as cards under a Sources disclosure that starts open, and opens the cited revision from the preview', async () => {
    const { onOpen } = mount({})
    const trigger = screen.getByRole('button', { name: /Sources \(2\)/ })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const list = screen.getByRole('list', { name: 'References' })
    const card = await within(list).findByRole('button', { name: /Summary/ })
    fireEvent.click(card)
    // The preview names the record; Open hands the typed reference back.
    expect(await screen.findByText('results/summary.csv', { selector: '.agx-src__preview-title' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(onOpen).toHaveBeenCalledWith(summary)
    fireEvent.click(trigger)
    await waitFor(() => expect(screen.queryByRole('list', { name: 'References' })).not.toBeInTheDocument())
  })

  it('says in the trigger how many sources changed or are gone, so a collapsed list still warns', async () => {
    const { container } = mount({ 'results/summary.csv': 'changed', 'notes.md': 'removed' })
    expect(await screen.findByRole('button', { name: 'Sources (2) · 2 changed or gone' })).toBeInTheDocument()
    // Each affected card carries its state: a toned dot whose text is read out.
    const warn = container.querySelector('.agx-src__dot[data-tone="warn"]')
    const gone = container.querySelector('.agx-src__dot[data-tone="error"]')
    expect(warn).not.toBeNull()
    expect(gone).not.toBeNull()
    expect(warn).toHaveTextContent('Changed since cited')
    expect(gone).toHaveTextContent('No longer exists')
  })

  it('keeps a leading item (the Task) above the cards in the same disclosure', () => {
    mount({}, { leading: true })
    expect(screen.getByText('Task chip')).toBeInTheDocument()
    const list = screen.getByRole('list', { name: 'References' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
  })
})
