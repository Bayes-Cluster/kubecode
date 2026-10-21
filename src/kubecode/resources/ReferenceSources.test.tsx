import { fireEvent, render, screen, within } from '@testing-library/react'
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
  render(
    <ReferenceResolverProvider api={{ resolveProjectContext } as unknown as KubecodeApi} events={[]} projectId="p1">
      <ReferenceSources
        leading={extra.leading ? <span>Task chip</span> : undefined}
        references={[{ ref: summary, title: 'Summary' }, { ref: notes }]}
        t={t}
        onOpen={onOpen}
      />
    </ReferenceResolverProvider>,
  )
  return { onOpen }
}

describe('ReferenceSources', () => {
  it('lists cited materials under a Sources disclosure that starts open, with the list named References', async () => {
    const { onOpen } = mount({})
    const trigger = screen.getByRole('button', { name: /Sources \(2\)/ })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const list = screen.getByRole('list', { name: 'References' })
    const chip = await within(list).findByRole('button', { name: 'File results/summary.csv #3f2c1a9' })
    fireEvent.click(chip)
    expect(onOpen).toHaveBeenCalledWith(summary)
    fireEvent.click(trigger)
    expect(screen.queryByRole('list', { name: 'References' })).not.toBeInTheDocument()
  })

  it('says in the trigger how many sources changed or are gone, so a collapsed list still warns', async () => {
    mount({ 'results/summary.csv': 'changed', 'notes.md': 'removed' })
    expect(await screen.findByRole('button', { name: 'Sources (2) · 2 changed or gone' })).toBeInTheDocument()
  })

  it('keeps a leading item (the Task) first in the same list', () => {
    mount({}, { leading: true })
    const items = within(screen.getByRole('list', { name: 'References' })).getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('Task chip')
  })
})
