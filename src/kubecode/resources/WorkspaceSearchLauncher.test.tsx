import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import type { KubecodeApi } from '../api'
import { fakeNavigation } from '../app/inspector/inspectorTesting'
import { createPlaceMemory, placeKey } from '../app/location/placeMemory'
import { PlaceMemoryProvider } from '../app/location/PlaceMemoryProvider'
import { WorkspaceNavigationContext } from '../app/location/WorkspaceNavigation'
import { WorkspaceSearchLauncher } from './WorkspaceSearchLauncher'

const t = createTranslator('en')

function mount(narrow: boolean) {
  const memory = createPlaceMemory()
  const navigation = fakeNavigation()
  const searchProjectContext = vi.fn().mockResolvedValue({
    items: [{
      ref: { kind: 'finding', id: 'f1', revision: '1' },
      title: 'Pruning keeps accuracy',
      summary: '',
      provenance: { author: null, updated_at: null, research_id: null, parent: null, state: null },
      availability: 'available',
    }],
    next_cursor: null,
    truncated: false,
  })
  render(
    <PlaceMemoryProvider memory={memory}>
      <WorkspaceNavigationContext.Provider value={navigation}>
        <WorkspaceSearchLauncher
          api={{ searchProjectContext } as unknown as KubecodeApi}
          events={[]}
          narrow={narrow}
          t={t}
          workspaceName="Pruning lab"
        />
      </WorkspaceNavigationContext.Provider>
    </PlaceMemoryProvider>,
  )
  return { memory, navigation, searchProjectContext }
}

describe('WorkspaceSearchLauncher', () => {
  it('names the Workspace it searches and previews a result over the current view', async () => {
    const { navigation, searchProjectContext } = mount(false)
    fireEvent.click(screen.getByRole('button', { name: 'Search Pruning lab' }))
    const input = await screen.findByRole('combobox', { name: 'Search Pruning lab' })
    expect(screen.getByRole('note')).toHaveTextContent('never searched')
    fireEvent.change(input, { target: { value: 'pruning' } })
    await screen.findByRole('option', { name: /Pruning keeps accuracy/ })
    await waitFor(() => expect(searchProjectContext).toHaveBeenLastCalledWith('p1', expect.objectContaining({ query: 'pruning', limit: 8 })))
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(navigation.inspect).toHaveBeenCalledWith({ kind: 'resource', ref: { kind: 'finding', id: 'f1', revision: null } }, { mode: 'reset' })
    await waitFor(() => expect(screen.queryByRole('combobox')).not.toBeInTheDocument())
  })

  it('carries the words to Resources', async () => {
    const { memory, navigation } = mount(false)
    fireEvent.click(screen.getByRole('button', { name: 'Search Pruning lab' }))
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'heads' } })
    fireEvent.click(screen.getByRole('button', { name: 'See all results in Resources' }))
    expect(memory.get(`${placeKey.view('p1', 'resources')}#query`)).toBe('heads')
    expect(navigation.openPlace).toHaveBeenCalledWith({ view: 'resources' }, { focus: 'resources:search' })
  })

  it('on a phone, is a button to Resources with the search focused', () => {
    const { navigation } = mount(true)
    fireEvent.click(screen.getByRole('button', { name: 'Search this Workspace' }))
    expect(navigation.openPlace).toHaveBeenCalledWith({ view: 'resources' }, { focus: 'resources:search' })
  })
})
