import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import type { KubecodeApi, ProjectContextItem, ProjectContextKind, ProjectContextPage, WorkspaceEvent } from '../api'
import { createPlaceMemory } from '../app/location/placeMemory'
import { PlaceMemoryProvider } from '../app/location/PlaceMemoryProvider'
import { WorkspaceSearch, type WorkspaceSearchProps } from './WorkspaceSearch'

const t = createTranslator('en')

const item = (kind: ProjectContextKind, id: string, title: string, extra: Partial<ProjectContextItem> = {}): ProjectContextItem => ({
  ref: { kind, id, revision: null },
  title,
  summary: `${title} summary`,
  provenance: { author: null, updated_at: '2026-10-20 09:00:00', research_id: null, parent: null, state: null },
  availability: 'available',
  ...extra,
})

const page = (items: ProjectContextItem[], extra: Partial<ProjectContextPage> = {}): ProjectContextPage => ({
  items,
  next_cursor: null,
  truncated: false,
  searched: ['research', 'finding', 'experiment', 'artifact', 'import', 'thread', 'file'],
  truncated_kinds: [],
  counts: { research: 0, finding: items.length, file: 0 },
  ...extra,
})

function mount(search: ReturnType<typeof vi.fn>, props: Partial<WorkspaceSearchProps> = {}, memory = createPlaceMemory()) {
  const onChoose = vi.fn()
  const onAttachCurrent = vi.fn()
  const api = { searchProjectContext: search } as unknown as KubecodeApi
  const element = (extra: Partial<WorkspaceSearchProps> = {}) => (
    <PlaceMemoryProvider memory={memory}>
      <WorkspaceSearch
        api={api}
        debounceMs={0}
        events={[]}
        memoryKey="p1|view:resources"
        mode="browse"
        projectId="p1"
        t={t}
        workspaceName="Pruning lab"
        onAttachCurrent={onAttachCurrent}
        onChoose={onChoose}
        {...props}
        {...extra}
      />
    </PlaceMemoryProvider>
  )
  const view = render(element())
  return { ...view, onChoose, onAttachCurrent, memory, rerenderWith: (extra: Partial<WorkspaceSearchProps>) => view.rerender(element(extra)) }
}

describe('WorkspaceSearch', () => {
  it('names its scope, the Workspace, and what is never searched', async () => {
    const search = vi.fn().mockResolvedValue(page([item('finding', 'f1', 'Heads are redundant')]))
    mount(search)
    expect(screen.getByRole('combobox', { name: 'Search Pruning lab' })).toBeInTheDocument()
    const note = screen.getByRole('note')
    expect(note).toHaveTextContent('Searching Tasks, Findings, Experiments and artifacts, Discussions, and Files in Pruning lab.')
    expect(note).toHaveTextContent('Message text and direct messages are never searched.')
    expect(await screen.findByRole('option', { name: /Heads are redundant/ })).toBeInTheDocument()
    expect(search).toHaveBeenCalledWith('p1', expect.objectContaining({
      kinds: ['research', 'finding', 'experiment', 'artifact', 'import', 'thread', 'file'],
    }))
    // Files are on: the walk's limits are said.
    expect(screen.getByText('Hidden, Git-ignored, and generated files are skipped.')).toBeInTheDocument()
  })

  it('toggles sections, shows their matches, and says which were cut short', async () => {
    const search = vi.fn().mockResolvedValue(page([item('finding', 'f1', 'Heads')], {
      counts: { research: 3, finding: 200, file: 0 }, truncated: true, truncated_kinds: ['finding'],
    }))
    mount(search)
    await screen.findByRole('option')
    const sections = screen.getByRole('group', { name: 'Search in' })
    expect(within(sections).getByRole('button', { name: 'Tasks, 3 matches' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(sections).getByRole('button', { name: 'Findings, more than 200 matches' })).toHaveTextContent('200+')
    expect(within(sections).getByRole('button', { name: 'Execution history' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('Only the most recent Findings were searched. Add words to narrow the search.')).toBeInTheDocument()

    fireEvent.click(within(sections).getByRole('button', { name: /^Execution history/ }))
    await waitFor(() => expect(search).toHaveBeenLastCalledWith('p1', expect.objectContaining({
      kinds: ['research', 'finding', 'experiment', 'artifact', 'import', 'thread', 'file', 'session', 'team', 'team_task', 'work', 'round'],
    })))
    fireEvent.click(within(sections).getByRole('button', { name: /^Files/ }))
    await waitFor(() => expect(screen.queryByText('Hidden, Git-ignored, and generated files are skipped.')).not.toBeInTheDocument())
  })

  it('asks for a section rather than searching nothing', async () => {
    const search = vi.fn().mockResolvedValue(page([]))
    mount(search)
    const sections = screen.getByRole('group', { name: 'Search in' })
    for (const name of [/^Tasks/, /^Findings/, /^Experiments/, /^Discussions/, /^Files/]) {
      fireEvent.click(within(sections).getByRole('button', { name }))
    }
    expect(await screen.findByText('Choose at least one section to search.')).toBeInTheDocument()
  })

  it('moves over results with the keyboard and previews the chosen one, keyed for focus return', async () => {
    const search = vi.fn().mockResolvedValue(page([item('research', 'r1', 'Prune heads'), item('finding', 'f1', 'Heads')]))
    const { onChoose } = mount(search)
    await screen.findAllByRole('option')
    const input = screen.getByRole('combobox')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: /Heads summary/ }).id)
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(onChoose).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ key: 'finding:f1' }), 'resource:finding:f1')
    fireEvent.keyDown(input, { key: 'Home' })
    fireEvent.click(screen.getByRole('option', { name: /Prune heads/ }))
    expect(onChoose).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'research:r1' }), 'resource:research:r1')
  })

  it('in attach mode, Enter attaches the current version and → previews; a removed record is refused', async () => {
    const search = vi.fn().mockResolvedValue(page([
      item('file', 'results/summary.csv', 'results/summary.csv'),
      item('artifact', 'a1', 'old.csv', { availability: 'removed' }),
    ]))
    const { onAttachCurrent, onChoose } = mount(search, { mode: 'attach' })
    await screen.findAllByRole('option')
    const input = screen.getByRole('combobox')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAttachCurrent).toHaveBeenCalledWith(expect.objectContaining({ key: 'file:results/summary.csv' }))
    fireEvent.keyDown(input, { key: 'ArrowRight' })
    expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ key: 'file:results/summary.csv' }), 'resource:file:results/summary.csv')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: /old\.csv/ })).toHaveTextContent('No longer exists')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAttachCurrent).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert')).toHaveTextContent('It no longer exists, so it cannot be added.')
  })

  it('a removed record can still be previewed when browsing', async () => {
    const search = vi.fn().mockResolvedValue(page([item('artifact', 'a1', 'old.csv', { availability: 'removed' })]))
    const { onChoose } = mount(search)
    fireEvent.click(await screen.findByRole('option', { name: /old\.csv/ }))
    expect(onChoose).toHaveBeenCalled()
  })

  it('clears the words with Escape before anything else hears it', async () => {
    const search = vi.fn().mockResolvedValue(page([]))
    const outer = vi.fn()
    render(
      <div onKeyDown={(event) => { if (event.key === 'Escape') outer() }}>
        <PlaceMemoryProvider>
          <WorkspaceSearch
            api={{ searchProjectContext: search } as unknown as KubecodeApi}
            debounceMs={0}
            events={[]}
            memoryKey="k"
            mode="quick"
            projectId="p1"
            t={t}
            workspaceName="Lab"
            onChoose={vi.fn()}
          />
        </PlaceMemoryProvider>
      </div>,
    )
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'pruning' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input).toHaveValue('')
    expect(outer).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(outer).toHaveBeenCalledTimes(1)
  })

  it('says when nothing matches, and when the Workspace changed since, without reflowing', async () => {
    const search = vi.fn().mockResolvedValue(page([]))
    const view = mount(search)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zebra' } })
    expect(await screen.findByText(/matches “zebra”\./)).toBeInTheDocument()
    expect(screen.getByText('Try fewer words, or search more sections.')).toBeInTheDocument()
    const events: WorkspaceEvent[] = [{ id: 3, kind: 'research_updated', payload: {}, project_id: 'p1', conversation_id: null, run_id: null, created_at: '' }]
    view.rerenderWith({ events })
    expect(screen.getByText('This Workspace changed since these results.')).toBeInTheDocument()
    const before = search.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(search).toHaveBeenCalledTimes(before + 1))
    await waitFor(() => expect(screen.queryByText('This Workspace changed since these results.')).not.toBeInTheDocument())
  })

  it('says a search failed and tries again', async () => {
    const search = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(page([item('finding', 'f1', 'Heads')]))
    mount(search)
    expect(await screen.findByRole('alert')).toHaveTextContent('Search failed.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('option')).toBeInTheDocument()
  })

  it('keeps the words, sections, and active row for the place', async () => {
    const memory = createPlaceMemory()
    const search = vi.fn().mockResolvedValue(page([item('finding', 'f1', 'Heads'), item('finding', 'f2', 'Tails')]))
    const first = mount(search, {}, memory)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'h' } })
    fireEvent.click(within(screen.getByRole('group', { name: 'Search in' })).getByRole('button', { name: /^Files/ }))
    await screen.findAllByRole('option')
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' })
    first.unmount()
    mount(search, {}, memory)
    expect(screen.getByRole('combobox')).toHaveValue('h')
    expect(within(screen.getByRole('group', { name: 'Search in' })).getByRole('button', { name: /^Files/ })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: /Tails/ }).id)
  })

  it('names the Task a result belongs to', async () => {
    const search = vi.fn().mockResolvedValue(page([item('finding', 'f1', 'Heads', {
      provenance: { author: null, updated_at: null, research_id: 'r1', parent: null, state: null },
    })]))
    mount(search, { taskTitle: (id) => (id === 'r1' ? 'Prune heads' : undefined) })
    expect(await screen.findByRole('option')).toHaveTextContent('In Prune heads')
  })
})
