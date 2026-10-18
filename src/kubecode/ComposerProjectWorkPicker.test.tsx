import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import { ComposerProjectWorkPicker } from './ComposerProjectWorkPicker'
import type { KubecodeApi, ProjectContextItem } from './api'

function item(
  kind: ProjectContextItem['ref']['kind'],
  id: string,
  title: string,
  overrides: Partial<ProjectContextItem> = {},
): ProjectContextItem {
  return {
    ref: { kind, id, revision: '1' },
    title,
    summary: `${title} summary`,
    provenance: {
      author: 'agent', updated_at: '2026-10-18 10:00:00', research_id: null, parent: null,
      state: 'open',
    },
    availability: 'available',
    ...overrides,
  }
}

function setup(items: ProjectContextItem[], extra: Partial<Record<string, unknown>> = {}) {
  const api = {
    searchProjectContext: vi.fn().mockResolvedValue({ items, next_cursor: null, truncated: false }),
    readProjectContext: vi.fn().mockResolvedValue({
      ref: items[0]?.ref,
      detail: 'content',
      title: items[0]?.title,
      availability: 'available',
      provenance: items[0]?.provenance,
      sections: [{ heading: 'Approved brief', text: 'Does it hold?', truncated: false }],
      related: [],
      next_cursor: null,
      notes: ['A finding is an Agent claim.'],
    }),
    ...extra,
  }
  const onSelect = vi.fn()
  render(
    <ComposerProjectWorkPicker
      api={api as unknown as KubecodeApi}
      conversationId="session-1"
      onSelect={onSelect}
      projectId="project-1"
      t={createTranslator('en')}
    />,
  )
  return { api, onSelect }
}

describe('ComposerProjectWorkPicker', () => {
  it('lists Project work with identity and provenance and selects with the keyboard', async () => {
    const { api, onSelect } = setup([
      item('research', 'r1', 'Pruning'),
      item('finding', 'f1', 'Accuracy holds'),
    ])
    const options = await screen.findAllByRole('option')
    expect(options).toHaveLength(2)
    expect(options[0]).toHaveTextContent('Pruning')
    expect(options[0]).toHaveTextContent('Research')
    expect(options[0]).toHaveTextContent('agent')
    expect(options[1]).toHaveTextContent('Finding')
    expect(api.searchProjectContext).toHaveBeenCalledWith('project-1', {
      query: '', kinds: undefined, limit: 20,
    })
    const input = screen.getByRole('combobox', { name: 'Search Project work' })
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    expect(input).toHaveAttribute('aria-activedescendant', options[1].id)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0][0].ref).toEqual({ kind: 'finding', id: 'f1', revision: '1' })
  })

  it('searches with the typed query and the chosen kind group', async () => {
    const { api } = setup([item('research', 'r1', 'Pruning')])
    await screen.findByRole('option')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'weight decay' } })
    await waitFor(() => expect(api.searchProjectContext).toHaveBeenLastCalledWith('project-1', {
      query: 'weight decay', kinds: undefined, limit: 20,
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Teams' }))
    await waitFor(() => expect(api.searchProjectContext).toHaveBeenLastCalledWith('project-1', {
      query: 'weight decay', kinds: ['team', 'team_task'], limit: 20,
    }))
    expect(screen.getByRole('button', { name: 'Teams' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('skips changed or removed rows when navigating and never selects them', async () => {
    const { onSelect } = setup([
      item('research', 'r1', 'Gone', { availability: 'removed' }),
      item('research', 'r2', 'Fresh'),
      item('research', 'r3', 'Moved', { availability: 'changed' }),
    ])
    const options = await screen.findAllByRole('option')
    expect(options[0]).toHaveAttribute('aria-disabled', 'true')
    expect(options[0]).toHaveTextContent('Changed or removed since it was listed')
    // The first enabled row is active, and the arrows never land on disabled ones.
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    const input = screen.getByRole('combobox')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(within(options[2]).getAllByRole('button')[0])
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ title: 'Fresh' }))
  })

  it('never offers the current Session or its own turns through this picker', async () => {
    setup([
      item('session', 'session-1', 'This very Session'),
      item('session_turn', 'session-1/run-1', 'Turn of this Session'),
      item('session', 'session-2', 'Another Session'),
    ])
    const options = await screen.findAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveTextContent('Another Session')
  })

  it('ignores keys pressed during IME composition', async () => {
    const { onSelect } = setup([item('research', 'r1', 'Pruning')])
    await screen.findByRole('option')
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter', isComposing: true })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('previews read-only content and offers a referenced turn from a Session preview', async () => {
    const turn = item('session_turn', 'session-2/run-9', 'Turn: the sweep')
    const { api, onSelect } = setup(
      [item('session', 'session-2', 'Earlier sweep')],
      {
        readProjectContext: vi.fn().mockResolvedValue({
          ref: { kind: 'session', id: 'session-2', revision: '1' },
          detail: 'content', title: 'Earlier sweep', availability: 'available',
          provenance: {}, sections: [{ heading: 'Turns', text: 'run-9 [completed] the sweep', truncated: false }],
          related: [turn], next_cursor: null, notes: ['A turn is still running.'],
        }),
      },
    )
    await screen.findByRole('option')
    fireEvent.click(screen.getByRole('button', { name: 'Preview Earlier sweep' }))
    const preview = await screen.findByRole('region', { name: 'Project work preview' })
    expect(await within(preview).findByText('run-9 [completed] the sweep')).toBeInTheDocument()
    expect(within(preview).getByText('A turn is still running.')).toBeInTheDocument()
    expect(api.readProjectContext).toHaveBeenCalledWith(
      'project-1', { kind: 'session', id: 'session-2', revision: '1' }, 'content',
    )
    // Previewing selected nothing.
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.click(within(preview).getByRole('button', { name: 'Reference turn: Turn: the sweep' }))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
      ref: { kind: 'session_turn', id: 'session-2/run-9', revision: '1' },
    }))
  })

  it('reports empty, failed, and preview-failed states explicitly', async () => {
    const empty = setup([])
    expect(await screen.findByText('No matching Project work.')).toBeInTheDocument()
    expect(empty.onSelect).not.toHaveBeenCalled()
  })

  it('shows a load failure and a preview failure instead of an empty list', async () => {
    setup([item('research', 'r1', 'Pruning')], {
      readProjectContext: vi.fn().mockRejectedValue(new Error('boom')),
    })
    await screen.findByRole('option')
    fireEvent.click(screen.getByRole('button', { name: 'Preview Pruning' }))
    expect(await screen.findByText('The preview could not be loaded.')).toBeInTheDocument()
  })

  it('shows an error when the search fails and loads further pages on request', async () => {
    const search = vi.fn()
      .mockResolvedValueOnce({ items: [item('research', 'r1', 'First')], next_cursor: 'c1', truncated: false })
      .mockResolvedValueOnce({ items: [item('research', 'r2', 'Second')], next_cursor: null, truncated: false })
    setup([], { searchProjectContext: search })
    await screen.findByText('First')
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await screen.findByText('Second')
    expect(search).toHaveBeenLastCalledWith('project-1', {
      query: '', kinds: undefined, limit: 20, cursor: 'c1',
    })
    expect(screen.getAllByRole('option')).toHaveLength(2)
  })

  it('reports a search failure', async () => {
    setup([], { searchProjectContext: vi.fn().mockRejectedValue(new Error('down')) })
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not/i)
  })
})
