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
      query: 'weight decay', kinds: ['team', 'team_task', 'work'], limit: 20,
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
    expect(options[0]).toHaveTextContent('Removed since it was listed')
    expect(options[2]).toHaveTextContent('Changed since it was listed')
    // The first enabled row is active, and the arrows never land on disabled ones.
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    const input = screen.getByRole('combobox')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(options[2])
    fireEvent.click(options[0])
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
    fireEvent.click(screen.getByRole('button', { name: 'Preview selected' }))
    const preview = await screen.findByRole('region', { name: 'Project work preview' })
    expect(await within(preview).findByText('run-9 [completed] the sweep')).toBeInTheDocument()
    expect(within(preview).getByText('A turn is still running.')).toBeInTheDocument()
    // Read live through the one record reader (ADR 0231 §4).
    expect(api.readProjectContext).toHaveBeenCalledWith(
      'project-1', { kind: 'session', id: 'session-2' }, 'content',
    )
    // Previewing selected nothing.
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.click(within(preview).getByRole('button', { name: 'Turn: the sweep' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Preview selected' }))
    expect(await screen.findByText('Could not load this record.')).toBeInTheDocument()
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

  it('does not select on Shift+Tab, and previews with ArrowRight when the query is empty', async () => {
    const { api, onSelect } = setup([item('research', 'r1', 'Pruning')])
    await screen.findByRole('option')
    const input = screen.getByRole('combobox')
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'ArrowRight' })
    expect(await screen.findByRole('region', { name: 'Project work preview' })).toBeInTheDocument()
    expect(api.readProjectContext).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('peels the preview with Escape before the surrounding menu sees it', async () => {
    const outerEscapes = vi.fn()
    const outer = (event: { key: string }) => {
      if (event.key === 'Escape') outerEscapes()
    }
    const api = {
      searchProjectContext: vi.fn().mockResolvedValue({
        items: [item('research', 'r1', 'Pruning')], next_cursor: null, truncated: false,
      }),
      readProjectContext: vi.fn().mockResolvedValue({
        ref: { kind: 'research', id: 'r1', revision: '1' }, detail: 'content', title: 'Pruning',
        availability: 'available', provenance: {}, sections: [], related: [], next_cursor: null, notes: [],
      }),
    }
    render(
      <div onKeyDown={outer}>
        <ComposerProjectWorkPicker
          api={api as unknown as KubecodeApi}
          conversationId="session-1"
          onSelect={vi.fn()}
          projectId="project-1"
          t={createTranslator('en')}
        />
      </div>,
    )
    await screen.findByRole('option')
    const input = screen.getByRole('combobox')
    fireEvent.keyDown(input, { key: 'ArrowRight' })
    await screen.findByRole('region', { name: 'Project work preview' })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: 'Project work preview' })).not.toBeInTheDocument()
    expect(outerEscapes).not.toHaveBeenCalled()
    // With nothing left to peel, Escape reaches the menu.
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(outerEscapes).toHaveBeenCalledTimes(1)
  })

  it('replaces rows on a new search so stale rows are never selectable, and ignores a late response', async () => {
    let resolveSlow: (page: unknown) => void = () => {}
    const search = vi.fn()
      .mockResolvedValueOnce({ items: [item('research', 'r1', 'Old row')], next_cursor: null, truncated: false })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSlow = resolve }))
      .mockResolvedValueOnce({ items: [item('research', 'r3', 'Newest row')], next_cursor: null, truncated: false })
    const { onSelect } = setup([], { searchProjectContext: search })
    await screen.findByText('Old row')
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'slow' } })
    await screen.findByRole('status')
    expect(screen.queryByText('Old row')).not.toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'fast' } })
    await screen.findByText('Newest row')
    // The slow, superseded response arrives last and must not replace the list.
    resolveSlow({ items: [item('research', 'r2', 'Late row')], next_cursor: null, truncated: false })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByText('Late row')).not.toBeInTheDocument()
    expect(screen.getByText('Newest row')).toBeInTheDocument()
  })

  it('keeps the loaded rows when only the next page fails', async () => {
    const search = vi.fn()
      .mockResolvedValueOnce({ items: [item('research', 'r1', 'First')], next_cursor: 'c1', truncated: false })
      .mockRejectedValueOnce(new Error('down'))
    setup([], { searchProjectContext: search })
    await screen.findByText('First')
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(await screen.findByText('Could not load more results.')).toBeInTheDocument()
    expect(screen.getByText('First')).toBeInTheDocument()
  })

  it('never offers a Project file, and says when a kind was cut short', async () => {
    setup([
      item('research', 'r1', 'Pruning'),
      item('file', 'results/summary.csv', 'results/summary.csv'),
    ], {
      searchProjectContext: vi.fn().mockResolvedValue({
        items: [item('research', 'r1', 'Pruning'), item('file', 'results/summary.csv', 'results/summary.csv')],
        next_cursor: null,
        truncated: true,
        truncated_kinds: ['session'],
      }),
    })
    expect(await screen.findAllByRole('option')).toHaveLength(1)
    expect(screen.queryByText('results/summary.csv')).not.toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent('Only the most recent Session were searched.')
  })

  it('shows the revision and says whether a source changed or was removed', async () => {
    setup([item('research', 'r1', 'Pruning', { ref: { kind: 'research', id: 'r1', revision: '4' } })])
    const option = await screen.findByRole('option')
    expect(option).toHaveTextContent('Revision 4')
  })
})
