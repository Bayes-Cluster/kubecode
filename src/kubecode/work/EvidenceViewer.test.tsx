import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import { ApiError, type KubecodeApi } from '../api'
import { EvidenceViewer, type EvidenceTarget } from './EvidenceViewer'

const t = createTranslator('en')

function document(overrides: Record<string, unknown> = {}) {
  return {
    ref: { kind: 'artifact', id: 'a1', revision: 'b7' },
    detail: 'content',
    title: 'accuracy.csv',
    availability: 'available',
    provenance: {},
    sections: [{ heading: 'Rows', text: 'acc 0.91', truncated: false }],
    related: [{ ref: { kind: 'finding', id: 'f1', revision: null }, title: 'Heads are redundant' }],
    next_cursor: null,
    notes: [],
    ...overrides,
  }
}

function mount(target: EvidenceTarget, api: Partial<KubecodeApi>, props: Partial<Parameters<typeof EvidenceViewer>[0]> = {}) {
  const onDisplayed = vi.fn()
  const onFailed = vi.fn()
  const view = render(
    <EvidenceViewer
      api={api as KubecodeApi}
      projectId="p1"
      t={t}
      target={target}
      onDisplayed={onDisplayed}
      onFailed={onFailed}
      {...props}
    />,
  )
  return { ...view, onDisplayed, onFailed }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('EvidenceViewer', () => {
  it('reports a file once it is on screen, at the revision the read returned, with the cited one labelled', async () => {
    // A file is read through the context reader, with the fingerprint evidence is pinned with (ADR 0231 §1).
    const readProjectContext = vi.fn().mockResolvedValue(document({
      ref: { kind: 'file', id: 'results.csv', revision: 'c3c3c3c3c3c3c3c3' },
      title: 'results.csv',
      sections: [{ heading: 'Content', text: 'acc,0.50', truncated: false }],
      related: [],
      shown_revision: 'c3c3c3c3c3c3c3c3',
    }))
    const { onDisplayed } = mount({ kind: 'file', id: 'results.csv', revision: 'a1a1a1a1a1a1a1a1' }, { readProjectContext })
    expect(onDisplayed).not.toHaveBeenCalled()
    expect(await screen.findByText('acc,0.50')).toBeInTheDocument()
    expect(readProjectContext).toHaveBeenCalledWith('p1', { kind: 'file', id: 'results.csv' }, 'content')
    await waitFor(() => expect(onDisplayed).toHaveBeenCalledWith({ kind: 'file', id: 'results.csv', revision: 'c3c3c3c3c3c3c3c3', title: 'results.csv' }))
    expect(onDisplayed).toHaveBeenCalledTimes(1)
    // Versions in words, never raw fingerprints.
    expect(screen.getByText('Cited version: #a1a1a1a')).toBeInTheDocument()
    expect(screen.getByTestId('evidence-viewer')).toHaveAttribute('data-shown-revision', 'c3c3c3c3c3c3c3c3')
  })

  it('reports a Project record at its own reference revision', async () => {
    const readProjectContext = vi.fn().mockResolvedValue(document())
    const { onDisplayed } = mount({ kind: 'artifact', id: 'a1', revision: '3f' }, { readProjectContext })
    await waitFor(() => expect(onDisplayed).toHaveBeenCalledWith({ kind: 'artifact', id: 'a1', revision: 'b7', title: 'accuracy.csv' }))
  })

  it.each([
    ['a server failure', () => Promise.reject(new ApiError('internal', 'x', 500))],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a record that is gone', () => Promise.reject(new ApiError('not_found', 'x', 404))],
  ])('never reports %s as displayed, and says it failed', async (_name, read) => {
    const readProjectContext = vi.fn().mockImplementation(read)
    const { onDisplayed, onFailed } = mount({ kind: 'file', id: 'results.csv', revision: 'a1' }, { readProjectContext })
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    await settle()
    expect(onDisplayed).not.toHaveBeenCalled()
    expect(onFailed).toHaveBeenCalledTimes(1)
  })

  it('never reports a kind it cannot show, or a record reported removed', async () => {
    const { onDisplayed, onFailed } = mount({ kind: 'unknown', id: 'x' }, {})
    expect(await screen.findByRole('alert')).toHaveTextContent('This record no longer exists.')
    expect(onFailed).toHaveBeenCalled()
    const removed = mount(
      { kind: 'artifact', id: 'a1', revision: '3f' },
      { readProjectContext: vi.fn().mockResolvedValue(document({ availability: 'removed', sections: [] })) },
    )
    await removed.findAllByText('This record no longer exists.')
    await settle()
    expect(onDisplayed).not.toHaveBeenCalled()
    expect(removed.onDisplayed).not.toHaveBeenCalled()
  })

  it('hands a related record to the inspector instead of replacing what was cited', async () => {
    const readProjectContext = vi.fn().mockResolvedValue(document())
    const onFollow = vi.fn()
    const { onDisplayed } = mount({ kind: 'artifact', id: 'a1', revision: '3f' }, { readProjectContext }, { onFollow })
    fireEvent.click(await screen.findByRole('button', { name: 'Heads are redundant' }))
    expect(onFollow).toHaveBeenCalledWith({ kind: 'finding', id: 'f1' })
    expect(readProjectContext).toHaveBeenCalledTimes(1)
    expect(screen.getByText('acc 0.91')).toBeInTheDocument()
    await waitFor(() => expect(onDisplayed).toHaveBeenCalledTimes(1))
  })

  it('without a host to hand it to, follows a related record in place and never reports it as the cited one', async () => {
    const readProjectContext = vi.fn()
      .mockResolvedValueOnce(document())
      .mockResolvedValue(document({ ref: { kind: 'finding', id: 'f1', revision: 'f9' }, title: 'Heads are redundant', related: [] }))
    const { onDisplayed } = mount({ kind: 'artifact', id: 'a1', revision: '3f' }, { readProjectContext }, { onFollow: undefined })
    fireEvent.click(await screen.findByRole('button', { name: 'Heads are redundant' }))
    await waitFor(() => expect(readProjectContext).toHaveBeenCalledTimes(2))
    await screen.findByText('Heads are redundant', { selector: 'strong' })
    await settle()
    expect(onDisplayed).toHaveBeenCalledTimes(1)
    expect(onDisplayed).toHaveBeenCalledWith(expect.objectContaining({ kind: 'artifact', id: 'a1' }))
  })

  it('keeps what is shown when loading more fails, says so, and neither counts nor revokes the display', async () => {
    const readProjectContext = vi.fn()
      .mockResolvedValueOnce(document({ next_cursor: 'c1' }))
      .mockRejectedValueOnce(new ApiError('internal', 'x', 500))
      .mockResolvedValue(document({ sections: [{ heading: 'More', text: 'acc 0.92', truncated: false }] }))
    const { onDisplayed, onFailed } = mount({ kind: 'artifact', id: 'a1', revision: '3f' }, { readProjectContext })
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('More of this record could not be loaded.')
    expect(screen.getByText('acc 0.91')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('acc 0.92')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(onDisplayed).toHaveBeenCalledTimes(1)
    expect(onFailed).not.toHaveBeenCalled()
  })
})
