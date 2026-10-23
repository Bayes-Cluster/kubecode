import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'
import { nextFrame, stubScrollGeometry } from '@/test/scrollGeometry'

import type { KubecodeApi, ProjectContextItem, ProjectContextKind } from '../api'
import { fakeNavigation } from '../app/inspector/inspectorTesting'
import { createPlaceMemory } from '../app/location/placeMemory'
import { PlaceMemoryProvider } from '../app/location/PlaceMemoryProvider'
import { WorkspaceNavigationContext, type WorkspaceNavigation } from '../app/location/WorkspaceNavigation'
import { attachTargetKey } from './attachTarget'
import { ResourcesView } from './ResourcesView'

const t = createTranslator('en')

const item = (kind: ProjectContextKind, id: string, title: string): ProjectContextItem => ({
  ref: { kind, id, revision: null },
  title,
  summary: `${title} summary`,
  provenance: { author: null, updated_at: null, research_id: null, parent: null, state: null },
  availability: 'available',
})

function mount(navigation: WorkspaceNavigation = fakeNavigation({ location: { place: { view: 'resources' }, inspector: [] } }), memory = createPlaceMemory()) {
  const api = {
    searchProjectContext: vi.fn().mockResolvedValue({
      items: [item('research', 'r1', 'Pruning'), item('finding', 'f1', 'Heads are redundant'), item('artifact', 'a1', 'results.csv')],
      next_cursor: null,
      truncated: false,
    }),
    readProjectContext: vi.fn(),
  } as unknown as KubecodeApi
  const element = (
    <PlaceMemoryProvider memory={memory}>
      <WorkspaceNavigationContext.Provider value={navigation}>
        <ResourcesView api={api} events={[]} projectId="p1" t={t} workspaceName="Pruning lab" />
      </WorkspaceNavigationContext.Provider>
    </PlaceMemoryProvider>
  )
  const view = render(element)
  return { ...view, api, element, memory, navigation }
}

describe('ResourcesView', () => {
  it('is a library: choosing a record previews it in the inspector beside the list, and never leaves', async () => {
    const { api, navigation } = mount()
    expect(screen.getByRole('heading', { name: 'Resources', level: 2 })).toBeInTheDocument()
    expect(screen.getByText(/Choosing one previews it; previewing starts no work\./)).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('option', { name: /Heads are redundant/ }))
    expect(navigation.inspect).toHaveBeenCalledWith(
      { kind: 'resource', ref: { kind: 'finding', id: 'f1', revision: null } },
      { mode: 'reset', from: 'resource:finding:f1' },
    )
    fireEvent.click(screen.getByRole('option', { name: /Pruning/ }))
    expect(navigation.inspect).toHaveBeenLastCalledWith({ kind: 'task', id: 'r1' }, { mode: 'reset', from: 'resource:research:r1' })
    // Nothing is read here: the inspector previews it; there is no inline preview and no way "back".
    expect(api.readProjectContext).not.toHaveBeenCalled()
    expect(navigation.openPlace).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /^Back/ })).not.toBeInTheDocument()
  })

  it('marks the record the inspector shows', async () => {
    mount(fakeNavigation({
      location: { place: { view: 'resources' }, inspector: [{ kind: 'resource', ref: { kind: 'finding', id: 'f1' } }] },
    }))
    expect(await screen.findByRole('option', { name: /Heads are redundant/ })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('option', { name: /results\.csv/ })).not.toHaveAttribute('aria-current')
  })

  it('says a message is waiting for a reference, opens a Task as its brief to add, and returns or stops', async () => {
    const memory = createPlaceMemory()
    memory.set(attachTargetKey('p1'), { filter: 'r1', focusKey: 'composer:general' })
    const { navigation } = mount(undefined, memory)
    expect(screen.getByText('Adding to your message in General.')).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('option', { name: /Pruning/ }))
    expect(navigation.inspect).toHaveBeenCalledWith(
      { kind: 'resource', ref: { kind: 'research', id: 'r1', revision: null } },
      { mode: 'reset', from: 'resource:research:r1' },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Return to message' }))
    expect(navigation.openPlace).toHaveBeenCalledWith({ view: 'general', filter: 'r1' }, { inspector: 'closed', focus: 'composer:general' })
    expect(memory.get(attachTargetKey('p1'))).toBeNull()
    expect(screen.queryByText('Adding to your message in General.')).not.toBeInTheDocument()
  })

  it('stops adding without leaving', async () => {
    const memory = createPlaceMemory()
    memory.set(attachTargetKey('p1'), { filter: null, focusKey: 'composer:general' })
    const { navigation } = mount(undefined, memory)
    fireEvent.click(screen.getByRole('button', { name: 'Stop adding' }))
    expect(memory.get(attachTargetKey('p1'))).toBeNull()
    expect(navigation.openPlace).not.toHaveBeenCalled()
  })

  it('returns to where the results were scrolled, and names each row for focus return', async () => {
    const restore = stubScrollGeometry()
    try {
      const { element, memory, rerender } = mount()
      const row = await screen.findByRole('option', { name: /results\.csv/ })
      expect(row).toHaveAttribute('data-focus-key', 'resource:artifact:a1')
      expect(row).toHaveAttribute('data-scroll-anchor', 'resource:artifact:a1')
      const results = screen.getByTestId('search-results')
      results.scrollTop = 220
      fireEvent.scroll(results)
      await act(nextFrame)
      rerender(<PlaceMemoryProvider memory={memory}><p>General</p></PlaceMemoryProvider>)
      rerender(element)
      await screen.findByRole('option', { name: /results\.csv/ })
      await waitFor(() => expect(screen.getByTestId('search-results').scrollTop).toBe(220), { timeout: 5000 })
    } finally {
      restore()
    }
  })
})
