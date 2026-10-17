import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ResearchSummary, WorkspaceEvent } from '../api'
import { detailFixture, fakeApi } from './researchFixtures'
import { NewResearchDialog } from './NewResearchDialog'
import { ResearchNavigator } from './ResearchNavigator'
import { useResearchList } from './useResearch'

const t = ((key: string) => key) as never

const summary = (id: string, title: string, status: 'open' | 'resolved' = 'open'): ResearchSummary => ({
  id, project_id: 'p1', title, status, archived: false, revision: 1, entry_count: 0, link_count: 0, updated_at: '',
})

describe('ResearchNavigator', () => {
  const base = { activeResearchId: null, items: [], onNew: vi.fn(), onReload: vi.fn(), onSelect: vi.fn(), t }

  it('covers loading, error with retry, and empty states', () => {
    const { rerender } = render(<ResearchNavigator {...base} status="loading" />)
    expect(screen.getByRole('status')).toHaveTextContent('kubecode.research.loading')
    rerender(<ResearchNavigator {...base} status="error" />)
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.retry' }))
    expect(base.onReload).toHaveBeenCalled()
    rerender(<ResearchNavigator {...base} status="ready" />)
    expect(screen.getByText('kubecode.research.empty')).toBeInTheDocument()
  })

  it('lists questions, marks the open one, and selects by keyboard-reachable buttons', () => {
    const onSelect = vi.fn()
    const onNew = vi.fn()
    render(
      <ResearchNavigator
        {...base}
        activeResearchId="b"
        items={[summary('a', 'First'), summary('b', 'Second', 'resolved')]}
        onNew={onNew}
        onSelect={onSelect}
        status="ready"
      />,
    )
    expect(screen.getByRole('button', { name: /Second/ })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: /First/ })).not.toHaveAttribute('aria-current')
    expect(screen.getByText('kubecode.research.status.resolved')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /First/ }))
    expect(onSelect).toHaveBeenCalledWith('a')
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.research.new' }))
    expect(onNew).toHaveBeenCalled()
  })
})

describe('NewResearchDialog', () => {
  it('creates a question with a retry key and reports failures without closing', async () => {
    const createResearch = vi.fn()
      .mockRejectedValueOnce(new Error('no space'))
      .mockResolvedValue(detailFixture)
    const onCreated = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <NewResearchDialog
        api={fakeApi({ createResearch })}
        open
        onCreated={onCreated}
        onOpenChange={onOpenChange}
        projectId="p1"
        t={t}
      />,
    )
    const create = screen.getByRole('button', { name: 'kubecode.research.create' })
    expect(create).toBeDisabled()
    fireEvent.change(screen.getByLabelText('kubecode.research.field.title'), { target: { value: ' Pruning ' } })
    fireEvent.change(screen.getByLabelText('kubecode.research.field.question'), { target: { value: 'Does it hold?' } })
    fireEvent.click(create)
    expect(await screen.findByRole('alert')).toHaveTextContent('no space')
    expect(onCreated).not.toHaveBeenCalled()

    fireEvent.click(create)
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(detailFixture))
    expect(createResearch.mock.calls[0][1]).toEqual({ title: 'Pruning', question: 'Does it hold?' })
    expect(createResearch.mock.calls[1][2]).toBe(createResearch.mock.calls[0][2])
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

function ListProbe({ api, events, connection }: {
  api: ReturnType<typeof fakeApi>
  events: WorkspaceEvent[]
  connection: 'live' | 'reconnecting'
}) {
  const list = useResearchList(api, 'p1', events, connection)
  return <p>{list.status}:{list.items.map((item) => item.title).join(',')}</p>
}

describe('useResearchList', () => {
  const event = (id: number, project: string): WorkspaceEvent => ({
    id, kind: 'research_updated', project_id: project, conversation_id: null, run_id: null,
    payload: { research_id: 'x' }, created_at: '',
  })

  it('converges on Project events and after a reconnect, ignoring other Projects', async () => {
    const listResearch = vi.fn().mockResolvedValue([summary('a', 'First')])
    const api = fakeApi({ listResearch })
    const view = render(<ListProbe api={api} events={[]} connection="live" />)
    expect(await screen.findByText('ready:First')).toBeInTheDocument()
    const initial = listResearch.mock.calls.length

    await act(async () => view.rerender(<ListProbe api={api} events={[event(1, 'other')]} connection="live" />))
    expect(listResearch.mock.calls.length).toBe(initial)

    listResearch.mockResolvedValue([summary('a', 'First'), summary('b', 'Second')])
    await act(async () => view.rerender(<ListProbe api={api} events={[event(1, 'other'), event(2, 'p1')]} connection="live" />))
    expect(await screen.findByText('ready:First,Second')).toBeInTheDocument()

    await act(async () => view.rerender(<ListProbe api={api} events={[event(2, 'p1')]} connection="reconnecting" />))
    await act(async () => view.rerender(<ListProbe api={api} events={[event(2, 'p1')]} connection="live" />))
    await waitFor(() => expect(listResearch.mock.calls.length).toBe(initial + 2))
  })

  it('lists archived questions so they can be restored, and tolerates a host without research', async () => {
    const listResearch = vi.fn().mockResolvedValue([{ ...summary('a', 'Old'), archived: true }])
    render(<ListProbe api={fakeApi({ listResearch })} events={[]} connection="live" />)
    expect(await screen.findByText('ready:Old')).toBeInTheDocument()
    expect(listResearch).toHaveBeenCalledWith('p1', true)

    const bare = { ...fakeApi(), listResearch: undefined } as unknown as ReturnType<typeof fakeApi>
    render(<ListProbe api={bare} events={[]} connection="live" />)
    expect(await screen.findByText('ready:')).toBeInTheDocument()
  })

  it('reports a failed load', async () => {
    const api = fakeApi({ listResearch: vi.fn().mockRejectedValue(new Error('down')) })
    render(<ListProbe api={api} events={[]} connection="live" />)
    expect(await screen.findByText('error:')).toBeInTheDocument()
  })
})
