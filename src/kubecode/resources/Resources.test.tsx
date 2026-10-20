import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { KubecodeApi, ProjectContextItem } from '../api'
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
      canOpen={(reference) => reference.kind === 'research'}
      projectId="p1"
      t={t}
      onOpen={onOpen}
    />,
  )
  return { api, onOpen }
}

describe('ResourcesView', () => {
  it('previews a record read-only instead of attaching it, and offers Open only where there is somewhere to go', async () => {
    const { api, onOpen } = view()
    const row = await screen.findByRole('option', { name: /Pruning/ })
    fireEvent.click(row)
    expect(await screen.findByText('Does it hold?')).toBeInTheDocument()
    expect(api.readProjectContext).toHaveBeenCalledWith('p1', expect.objectContaining({ id: 'r1' }), 'content')
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.resources.open' }))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ kind: 'research', id: 'r1' }))

    // A record with nowhere to go can only be previewed.
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.projectWorkClosePreview' }))
    fireEvent.click(screen.getByRole('option', { name: /results\.csv/ }))
    await waitFor(() => expect(api.readProjectContext).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('button', { name: 'kubecode.resources.open' })).not.toBeInTheDocument()
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})
