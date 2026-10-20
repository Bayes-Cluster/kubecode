import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import { ApiError, type KubecodeApi, type ProjectContextDocument, type WorkspaceEvent } from '../api'
import { RecordPreview, type RecordPreviewProps } from './RecordPreview'

const t = createTranslator('en')
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function document(overrides: Partial<ProjectContextDocument> = {}): ProjectContextDocument {
  return {
    ref: { kind: 'file', id: 'results/summary.csv', revision: '3f2c1a9e5b7d4c6a' },
    detail: 'content',
    title: 'results/summary.csv',
    availability: 'available',
    provenance: { author: null, updated_at: null, research_id: null, parent: null, state: null },
    sections: [{ heading: 'Content', text: 'model,accuracy', truncated: false }],
    related: [],
    next_cursor: null,
    notes: [],
    shown_revision: '3f2c1a9e5b7d4c6a',
    ...overrides,
  }
}

const event = (id: number, kind: string, payload: Record<string, unknown> = {}): WorkspaceEvent => ({
  id, kind, payload, project_id: 'p1', conversation_id: null, run_id: null, created_at: '',
})

function mount(api: Partial<KubecodeApi>, props: Partial<RecordPreviewProps> = {}) {
  const onDisplayed = vi.fn()
  const element = (extra: Partial<RecordPreviewProps> = {}) => (
    <RecordPreview
      api={api as KubecodeApi}
      events={[]}
      projectId="p1"
      t={t}
      target={{ kind: 'file', id: 'results/summary.csv' }}
      onDisplayed={onDisplayed}
      {...props}
      {...extra}
    />
  )
  const view = render(element())
  return { ...view, onDisplayed, rerenderWith: (extra: Partial<RecordPreviewProps>) => view.rerender(element(extra)) }
}

describe('RecordPreview', () => {
  it('reads a file through the context reader, live, and reports the version it shows once it is on screen', async () => {
    const readProjectContext = vi.fn().mockResolvedValue(document())
    const { onDisplayed } = mount({ readProjectContext })
    expect(screen.getByRole('status')).toHaveTextContent('Loading…')
    expect(onDisplayed).not.toHaveBeenCalled()
    expect(await screen.findByText('model,accuracy')).toBeInTheDocument()
    expect(readProjectContext).toHaveBeenCalledWith('p1', { kind: 'file', id: 'results/summary.csv' }, 'content')
    await waitFor(() => expect(onDisplayed).toHaveBeenCalledWith({
      kind: 'file', id: 'results/summary.csv', revision: '3f2c1a9e5b7d4c6a', title: 'results/summary.csv',
    }))
    expect(onDisplayed).toHaveBeenCalledTimes(1)
    // The version in words, never the fingerprint.
    expect(screen.getByText('#3f2c1a9')).toBeInTheDocument()
    expect(screen.queryByText(/3f2c1a9e5b7d/)).not.toBeInTheDocument()
  })

  it('reports the revision whose content it shows, not the current one, for an older brief', async () => {
    const readProjectContext = vi.fn().mockResolvedValue(document({
      ref: { kind: 'research', id: 'r1', revision: '4' }, title: 'Prune heads', shown_revision: '3',
    }))
    const { onDisplayed } = mount({ readProjectContext }, { target: { kind: 'research', id: 'r1' } })
    await waitFor(() => expect(onDisplayed).toHaveBeenCalledWith(expect.objectContaining({ revision: '3' })))
  })

  it.each([
    ['a failed read', () => Promise.reject(new ApiError('internal', 'x', 500)), 'Could not load this record.'],
    ['a record that is gone', () => Promise.reject(new ApiError('not_found', 'x', 404)), 'This record no longer exists.'],
    ['a record reported removed', () => Promise.resolve(document({ availability: 'removed', sections: [] })), 'This record no longer exists.'],
    ['a file that is not text', () => Promise.resolve(document({ sections: [], notes: ['The file is not UTF-8 text, so no content is shown.'] })), 'not UTF-8'],
  ])('never reports %s as displayed', async (_name, read, text) => {
    const { onDisplayed } = mount({ readProjectContext: vi.fn().mockImplementation(read) })
    expect(await screen.findByText(new RegExp(text))).toBeInTheDocument()
    await settle()
    expect(onDisplayed).not.toHaveBeenCalled()
  })

  it('says a file with no text to show could not be shown, and reports it as failed', async () => {
    const onFailed = vi.fn()
    mount({ readProjectContext: vi.fn().mockResolvedValue(document({ sections: [], notes: ['The file is not UTF-8 text, so no content is shown.'] })) }, { onFailed })
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load this record.')
    expect(screen.getByText(/not UTF-8/)).toBeInTheDocument()
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith('failed'))
  })

  it('tries a failed read again', async () => {
    const readProjectContext = vi.fn()
      .mockRejectedValueOnce(new ApiError('internal', 'x', 500))
      .mockResolvedValue(document())
    mount({ readProjectContext })
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('model,accuracy')).toBeInTheDocument()
  })

  it('never swaps content under the reader: a change is announced, and the current version is shown on request', async () => {
    const readProjectContext = vi.fn().mockResolvedValue(document())
    const resolveProjectContext = vi.fn().mockResolvedValue([
      { ref: { kind: 'file', id: 'results/summary.csv' }, availability: 'available', current_revision: '9999aaaabbbbcccc', title: 'results/summary.csv' },
    ])
    const onShowCurrent = vi.fn()
    const view = mount({ readProjectContext, resolveProjectContext }, { onShowCurrent })
    await screen.findByText('model,accuracy')
    view.rerenderWith({ events: [event(1, 'research_updated')] })
    await settle()
    // An unrelated event does not ask.
    expect(resolveProjectContext).not.toHaveBeenCalled()
    view.rerenderWith({ events: [event(1, 'research_updated'), event(2, 'file_changed', { paths: ['results/summary.csv'] })] })
    expect(await screen.findByText("This changed after you opened it. You're reading the earlier version.")).toBeInTheDocument()
    expect(screen.getByText('model,accuracy')).toBeInTheDocument()
    expect(readProjectContext).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Show the current version' }))
    expect(onShowCurrent).toHaveBeenCalled()
  })

  it('without a host to show the current version, reads it again in place', async () => {
    const readProjectContext = vi.fn()
      .mockResolvedValueOnce(document())
      .mockResolvedValue(document({ sections: [{ heading: 'Content', text: 'model,accuracy,loss', truncated: false }], shown_revision: '9999aaaabbbbcccc' }))
    const resolveProjectContext = vi.fn().mockResolvedValue([
      { ref: { kind: 'file', id: 'results/summary.csv' }, availability: 'available', current_revision: '9999aaaabbbbcccc', title: null },
    ])
    const view = mount({ readProjectContext, resolveProjectContext })
    await screen.findByText('model,accuracy')
    view.rerenderWith({ events: [event(5, 'file_changed', { paths: ['results/summary.csv'] })] })
    fireEvent.click(await screen.findByRole('button', { name: 'Show the current version' }))
    expect(await screen.findByText('model,accuracy,loss')).toBeInTheDocument()
    await waitFor(() => expect(view.onDisplayed).toHaveBeenLastCalledWith(expect.objectContaining({ revision: '9999aaaabbbbcccc' })))
  })

  it('appends the next page, and stops when the file changed between pages', async () => {
    const readProjectContext = vi.fn()
      .mockResolvedValueOnce(document({ next_cursor: 'c1' }))
      .mockResolvedValueOnce(document({ sections: [{ heading: 'Content', text: 'pruned,0.90', truncated: false }], next_cursor: 'c2' }))
      .mockResolvedValueOnce(document({ availability: 'changed', sections: [], next_cursor: null, shown_revision: null }))
    mount({ readProjectContext })
    await screen.findByText('model,accuracy')
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(await screen.findByText('pruned,0.90')).toBeInTheDocument()
    expect(screen.getByText('model,accuracy')).toBeInTheDocument()
    expect(readProjectContext).toHaveBeenLastCalledWith('p1', { kind: 'file', id: 'results/summary.csv' }, 'content', 'c1')
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(await screen.findByText('It changed while the rest was loading. Show the current version to read on.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
    expect(screen.getByText('pruned,0.90')).toBeInTheDocument()
  })

  it('says a cited version changed, and hands related records to its host', async () => {
    const related = {
      ref: { kind: 'finding' as const, id: 'f1', revision: null },
      title: 'Heads are redundant',
      summary: '',
      provenance: { author: null, updated_at: null, research_id: null, parent: null, state: null },
      availability: 'available' as const,
    }
    const readProjectContext = vi.fn().mockResolvedValue(document({ related: [related] }))
    const onFollow = vi.fn()
    mount({ readProjectContext }, { cited: 'aaaabbbbccccdddd', onFollow })
    expect(await screen.findByText('Changed since it was cited.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Heads are redundant/ }))
    expect(onFollow).toHaveBeenCalledWith(related)
  })

  it('drops a read that lands after the target changed', async () => {
    let resolveFirst: (value: ProjectContextDocument) => void = () => undefined
    const readProjectContext = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockResolvedValue(document({ title: 'second.csv', sections: [{ heading: 'Content', text: 'second', truncated: false }] }))
    const view = mount({ readProjectContext })
    view.rerenderWith({ target: { kind: 'file', id: 'second.csv' } })
    expect(await screen.findByText('second')).toBeInTheDocument()
    await act(async () => resolveFirst(document()))
    expect(screen.queryByText('model,accuracy')).not.toBeInTheDocument()
  })
})
