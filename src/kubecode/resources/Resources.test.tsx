import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { KubecodeApi, ProjectContextItem } from '../api'
import { nextFrame, stubScrollGeometry } from '@/test/scrollGeometry'
import { createPlaceMemory } from '../app/location/placeMemory'
import { PlaceMemoryProvider } from '../app/location/PlaceMemoryProvider'
import { ResourcesView } from './ResourcesView'

const t = ((key: string, values?: Record<string, string | number>) => (
  values ? `${key}:${JSON.stringify(values)}` : key
)) as never

const item = (kind: string, id: string, title: string): ProjectContextItem => ({
  ref: { kind, id, revision: null },
  title,
  summary: `${title} summary`,
  provenance: { author: null, updated_at: null, research_id: null, parent: null, state: null },
  availability: 'available',
} as unknown as ProjectContextItem)

function view(onOpen = vi.fn()) {
  const api = {
    searchProjectContext: vi.fn().mockResolvedValue({
      items: [item('research', 'r1', 'Pruning'), item('artifact', 'a1', 'results.csv')],
      next_cursor: null,
    }),
    readProjectContext: vi.fn().mockResolvedValue({
      ref: { kind: 'research', id: 'r1', revision: null },
      availability: 'available',
      sections: [{ heading: 'Brief', text: 'Does it hold?' }],
      notes: [],
      related: [],
    }),
  } as unknown as KubecodeApi
  render(
    <ResourcesView
      api={api}
      projectId="p1"
      t={t}
      onOpen={onOpen}
    />,
  )
  return { api, onOpen }
}

describe('ResourcesView', () => {
  it('previews a record read-only instead of attaching it, and opens every record from its preview', async () => {
    const { api, onOpen } = view()
    const row = await screen.findByRole('option', { name: /Pruning/ })
    fireEvent.click(row)
    expect(await screen.findByText('Does it hold?')).toBeInTheDocument()
    expect(api.readProjectContext).toHaveBeenCalledWith('p1', expect.objectContaining({ id: 'r1' }), 'content')
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.resources.open' }))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ kind: 'research', id: 'r1' }))

    // A record opens in the inspector, so it has somewhere to go too.
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.projectWorkClosePreview' }))
    fireEvent.click(screen.getByRole('option', { name: /results\.csv/ }))
    await waitFor(() => expect(api.readProjectContext).toHaveBeenCalledTimes(2))
    fireEvent.click(await screen.findByRole('button', { name: 'kubecode.resources.open' }))
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'artifact', id: 'a1' }))
  })
})

describe('ResourcesView keeps its place (ADR 0228 §4)', () => {
  it('returns to where the results were scrolled, and names each row for focus return', async () => {
    const restore = stubScrollGeometry()
    try {
      const memory = createPlaceMemory()
      const api = {
        searchProjectContext: vi.fn().mockResolvedValue({
          items: [item('research', 'r1', 'Pruning'), item('artifact', 'a1', 'results.csv')],
          next_cursor: null,
        }),
      } as unknown as KubecodeApi
      const resources = (
        <PlaceMemoryProvider memory={memory}>
          <ResourcesView api={api} projectId="p1" scrollKey="p1|view:resources" t={t} onOpen={vi.fn()} />
        </PlaceMemoryProvider>
      )
      const view = render(resources)
      const row = await screen.findByRole('option', { name: /results\.csv/ })
      expect(row).toHaveAttribute('data-focus-key', 'resource:artifact:a1')
      expect(row).toHaveAttribute('data-scroll-anchor', 'resource:artifact:a1')
      const results = screen.getByTestId('project-work-results')
      results.scrollTop = 220
      fireEvent.scroll(results)
      await act(nextFrame)

      view.rerender(<PlaceMemoryProvider memory={memory}><p>General</p></PlaceMemoryProvider>)
      view.rerender(resources)
      await screen.findByRole('option', { name: /results\.csv/ })
      await waitFor(() => expect(screen.getByTestId('project-work-results').scrollTop).toBe(220))
    } finally {
      restore()
    }
  })
})
