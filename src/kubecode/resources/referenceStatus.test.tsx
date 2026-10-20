import { act, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import type { KubecodeApi, ProjectContextRef, WorkspaceEvent } from '../api'
import { ReferenceResolverProvider } from './ReferenceResolverProvider'
import { ResourceReferenceChip } from './ResourceReferenceChip'
import { createReferenceStatusStore, referenceChipLabel, type ReferenceStatus } from './referenceStatus'

const t = createTranslator('en')
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

const resolved = (refs: ProjectContextRef[], overrides: Record<string, Partial<{ availability: string; title: string | null }>> = {}) => (
  refs.map((ref) => ({
    ref,
    availability: overrides[ref.id]?.availability ?? 'available',
    current_revision: 'cccccccccccccccc',
    title: overrides[ref.id] && 'title' in overrides[ref.id] ? overrides[ref.id].title : `Title ${ref.id}`,
  }))
)

const event = (id: number, kind: string, payload: Record<string, unknown> = {}): WorkspaceEvent => ({
  id, kind, payload, project_id: 'p1', conversation_id: null, run_id: null, created_at: '',
})

describe('reference status store', () => {
  it('resolves in batches of at most 32, once per reference and revision', async () => {
    const resolveProjectContext = vi.fn().mockImplementation((_p: string, refs: ProjectContextRef[]) => Promise.resolve(resolved(refs)))
    const store = createReferenceStatusStore({ resolveProjectContext } as unknown as KubecodeApi, 'p1')
    const refs = Array.from({ length: 40 }, (_, index) => ({ kind: 'finding' as const, id: `f${index}`, revision: '1' }))
    store.request(refs)
    store.request(refs.slice(0, 5))
    await flush()
    expect(resolveProjectContext).toHaveBeenCalledTimes(2)
    expect(resolveProjectContext.mock.calls[0][1]).toHaveLength(32)
    expect(resolveProjectContext.mock.calls[1][1]).toHaveLength(8)
    expect(store.get(refs[0])).toEqual({ status: 'ready', availability: 'available', currentRevision: 'cccccccccccccccc', title: 'Title f0' })
    store.request(refs)
    await flush()
    expect(resolveProjectContext).toHaveBeenCalledTimes(2)
  })

  it('forgets only what an event may have changed: a changed file by its path', async () => {
    const resolveProjectContext = vi.fn().mockImplementation((_p: string, refs: ProjectContextRef[]) => Promise.resolve(resolved(refs)))
    const store = createReferenceStatusStore({ resolveProjectContext } as unknown as KubecodeApi, 'p1')
    const summary = { kind: 'file' as const, id: 'results/summary.csv', revision: 'aaaaaaaaaaaaaaaa' }
    const other = { kind: 'file' as const, id: 'notes.md', revision: 'bbbbbbbbbbbbbbbb' }
    const thread = { kind: 'thread' as const, id: 't1', revision: null }
    store.request([summary, other, thread])
    await flush()
    store.observe([event(1, 'file_changed', { paths: ['results/summary.csv'] })])
    expect(store.get(summary)).toEqual({ status: 'loading' })
    expect(store.get(other).status).toBe('ready')
    expect(store.get(thread).status).toBe('ready')
    store.observe([event(1, 'file_changed', { paths: ['results/summary.csv'] }), event(2, 'channel_updated')])
    expect(store.get(thread)).toEqual({ status: 'loading' })
  })

  it('says a failed resolve failed, without claiming any state', async () => {
    const store = createReferenceStatusStore({ resolveProjectContext: vi.fn().mockRejectedValue(new Error('down')) } as unknown as KubecodeApi, 'p1')
    store.request([{ kind: 'finding', id: 'f1' }])
    await flush()
    const status = store.get({ kind: 'finding', id: 'f1' })
    expect(status).toEqual({ status: 'error' })
    expect(referenceChipLabel({ kind: 'finding', id: 'f1' }, status, t, { basis: 'cited' }).state).toBeUndefined()
  })
})

describe('referenceChipLabel', () => {
  const ready = (availability: 'available' | 'changed' | 'removed', title: string | null): ReferenceStatus => (
    { status: 'ready', availability, currentRevision: null, title }
  )

  it('names a reference by the server title, then what the page knows, then a fallback; never by id', () => {
    const ref = { kind: 'file' as const, id: 'results/summary.csv', revision: '3f2c1a9e5b7d4c6a' }
    expect(referenceChipLabel(ref, ready('available', 'results/summary.csv'), t, { basis: 'cited' }))
      .toEqual({ kind: 'file', kindLabel: 'File', title: 'results/summary.csv', version: '#3f2c1a9', state: undefined })
    expect(referenceChipLabel({ kind: 'artifact', id: 'a-123' }, { status: 'loading' }, t, { basis: 'cited', knownTitle: 'acc.csv' }).title).toBe('acc.csv')
    expect(referenceChipLabel({ kind: 'artifact', id: 'a-123' }, { status: 'loading' }, t, { basis: 'cited' }).title).toBe('Artifact (no title)')
  })

  it('says in words whether it changed since cited or attached, no longer exists, or is not available here', () => {
    const ref = { kind: 'finding' as const, id: 'f1', revision: '1' }
    expect(referenceChipLabel(ref, ready('changed', 'Heads'), t, { basis: 'cited' }).state)
      .toEqual({ kind: 'changed', label: 'Changed since cited' })
    expect(referenceChipLabel(ref, ready('changed', 'Heads'), t, { basis: 'attached' }).state)
      .toEqual({ kind: 'changed', label: 'Changed since attached' })
    expect(referenceChipLabel(ref, ready('removed', null), t, { basis: 'cited' }).state)
      .toEqual({ kind: 'removed', label: 'No longer exists' })
    // A private Session is never named, and never said to exist or not.
    const hidden = referenceChipLabel({ kind: 'session', id: 'dm-1' }, ready('removed', null), t, { basis: 'cited' })
    expect(hidden.state).toEqual({ kind: 'unavailable', label: 'Not available here' })
    expect(hidden.title).toBe('Session (no title)')
  })
})

describe('ResourceReferenceChip', () => {
  it('shows kind, title, version and state as its name, and opens on click', async () => {
    const resolveProjectContext = vi.fn().mockImplementation((_p: string, refs: ProjectContextRef[]) => (
      Promise.resolve(resolved(refs, { 'results/summary.csv': { availability: 'changed', title: 'results/summary.csv' } }))
    ))
    const onOpen = vi.fn()
    render(
      <ReferenceResolverProvider api={{ resolveProjectContext } as unknown as KubecodeApi} events={[]} projectId="p1">
        <ResourceReferenceChip
          basis="cited"
          reference={{ kind: 'file', id: 'results/summary.csv', revision: '3f2c1a9e5b7d4c6a' }}
          t={t}
          onOpen={onOpen}
        />
      </ReferenceResolverProvider>,
    )
    const chip = await screen.findByRole('button', { name: 'File results/summary.csv #3f2c1a9 Changed since cited' })
    expect(chip.textContent).not.toContain('3f2c1a9e5b7d4c6a')
    chip.click()
    expect(onOpen).toHaveBeenCalled()
    expect(resolveProjectContext).toHaveBeenCalledWith('p1', [{ kind: 'file', id: 'results/summary.csv', revision: '3f2c1a9e5b7d4c6a' }])
  })

  it('drops a late answer for a Workspace that is no longer active', async () => {
    let answer: (value: unknown) => void = () => undefined
    const resolveProjectContext = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
      .mockImplementation((_p: string, refs: ProjectContextRef[]) => Promise.resolve(resolved(refs, { f1: { title: 'From p2' } })))
    const api = { resolveProjectContext } as unknown as KubecodeApi
    const chip = (projectId: string) => (
      <ReferenceResolverProvider api={api} events={[]} projectId={projectId}>
        <ResourceReferenceChip basis="cited" reference={{ kind: 'finding', id: 'f1' }} t={t} />
      </ReferenceResolverProvider>
    )
    const view = render(chip('p1'))
    await waitFor(() => expect(resolveProjectContext).toHaveBeenCalledTimes(1))
    view.rerender(chip('p2'))
    expect(await screen.findByText('From p2')).toBeInTheDocument()
    await act(async () => answer(resolved([{ kind: 'finding', id: 'f1' }], { f1: { title: 'From p1' } })))
    expect(screen.queryByText('From p1')).not.toBeInTheDocument()
  })
})
