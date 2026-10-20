import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { KubecodeApi, ProjectContextDocument } from '../api'
import { InspectorPane } from '../app/inspector/InspectorPane'
import { InspectorServicesContext } from '../app/inspector/inspectorContext'
import { INSPECTOR_PANELS } from '../app/inspector/inspectorPanels'
import { fakeNavigation, fakeServices, renderInspector } from '../app/inspector/inspectorTesting'
import type { InspectorEntry } from '../app/location/inspector'
import { createPlaceMemory } from '../app/location/placeMemory'
import { PlaceMemoryProvider } from '../app/location/PlaceMemoryProvider'
import { WorkspaceNavigationContext, type WorkspaceNavigation } from '../app/location/WorkspaceNavigation'
import { emptyGeneralDraft, type GeneralDraft } from '../channel/generalDraft'
import { attachTargetKey, generalDraftKey } from './attachTarget'

function finding(overrides: Partial<ProjectContextDocument> = {}): ProjectContextDocument {
  return {
    ref: { kind: 'finding', id: 'f1', revision: '1' },
    detail: 'content',
    title: 'Pruning keeps accuracy',
    availability: 'available',
    provenance: { author: null, updated_at: null, research_id: 'r1', parent: null, state: null },
    sections: [{ heading: 'Claim', text: 'Accuracy held at 0.91', truncated: false }],
    related: [],
    next_cursor: null,
    notes: [],
    shown_revision: '1',
    ...overrides,
  }
}

const file = (revision: string) => finding({
  ref: { kind: 'file', id: 'results/summary.csv', revision },
  title: 'results/summary.csv',
  provenance: { author: null, updated_at: null, research_id: null, parent: null, state: null },
  sections: [{ heading: 'Content', text: 'model,accuracy', truncated: false }],
  shown_revision: revision,
})

function mount(entry: InspectorEntry, read: ReturnType<typeof vi.fn>, navigation: WorkspaceNavigation = fakeNavigation(), memory = createPlaceMemory()) {
  const services = fakeServices({ api: { readProjectContext: read } as unknown as KubecodeApi })
  const view = render(
    <PlaceMemoryProvider memory={memory}>
      <WorkspaceNavigationContext.Provider value={navigation}>
        <InspectorServicesContext.Provider value={services}>
          <InspectorPane
            originLabel="Resources"
            panels={INSPECTOR_PANELS}
            presentation={navigation.presentation}
            projectId="p1"
            stack={[entry]}
            t={services.t}
            onBack={vi.fn()}
            onClose={vi.fn()}
            onPush={vi.fn()}
            onReplace={vi.fn()}
          />
        </InspectorServicesContext.Provider>
      </WorkspaceNavigationContext.Provider>
    </PlaceMemoryProvider>,
  )
  return { ...view, memory, navigation }
}

const draftOf = (memory: ReturnType<typeof createPlaceMemory>, filter: string | null = null) => memory.get(generalDraftKey('p1', filter)) as GeneralDraft | undefined

describe('ResourcePanel', () => {
  it('shows a record live in the inspector, under one heading named by its title, never its id', async () => {
    const read = vi.fn().mockResolvedValue(finding())
    renderInspector({
      services: fakeServices({ api: { readProjectContext: read } as unknown as KubecodeApi }),
      stack: [{ kind: 'resource', ref: { kind: 'finding', id: 'f1' } }],
    })
    expect(screen.getByRole('complementary', { name: 'Resource details' })).toBeInTheDocument()
    expect(await screen.findByText('Accuracy held at 0.91')).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Pruning keeps accuracy', level: 3 })).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(1)
    expect(read).toHaveBeenCalledWith('p1', { kind: 'finding', id: 'f1' }, 'content')
    expect(screen.queryByText(/f1/)).not.toBeInTheDocument()
  })

  it('adds the version on screen to General’s draft beside it, only once it is shown, and says so', async () => {
    let finish: (doc: ProjectContextDocument) => void = () => undefined
    const read = vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const navigation = fakeNavigation({ location: { place: { view: 'general', filter: 'r1' }, inspector: [] } })
    const { memory } = mount({ kind: 'resource', ref: { kind: 'file', id: 'results/summary.csv' } }, read, navigation)
    const add = screen.getByRole('button', { name: 'Add to message' })
    expect(add).toBeDisabled()
    expect(add).toHaveAccessibleDescription('Available once the preview has loaded.')
    finish(file('3f2c1a9e5b7d4c6a'))
    await waitFor(() => expect(add).toBeEnabled())
    expect(add).toHaveAccessibleDescription('Adds the version you are viewing to your message in General.')
    fireEvent.click(add)
    expect(draftOf(memory, 'r1')?.references).toEqual([
      { ref: { kind: 'file', id: 'results/summary.csv', revision: '3f2c1a9e5b7d4c6a' }, title: 'results/summary.csv', seen: 'previewed' },
    ])
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Added results/summary.csv to your message.')
    // Beside General: it stays.
    expect(navigation.openPlace).not.toHaveBeenCalled()
    expect(add).toBeDisabled()
    expect(add).toHaveAccessibleDescription('Already in your message')
  })

  it('on a phone, adding returns to the General composer', async () => {
    const navigation = fakeNavigation({ presentation: 'screen', location: { place: { view: 'general' }, inspector: [] } })
    mount({ kind: 'resource', ref: { kind: 'finding', id: 'f1' } }, vi.fn().mockResolvedValue(finding()), navigation)
    const add = screen.getByRole('button', { name: 'Add to message' })
    await waitFor(() => expect(add).toBeEnabled())
    fireEvent.click(add)
    expect(navigation.openPlace).toHaveBeenCalledWith({ view: 'general' }, { inspector: 'closed', focus: 'composer:general' })
  })

  it('from Resources, adds to General’s remembered draft, or returns to the draft that is waiting for it', async () => {
    const memory = createPlaceMemory()
    const navigation = fakeNavigation({
      location: { place: { view: 'resources' }, inspector: [] },
      rememberedGeneral: () => ({ filter: 'r1' }),
    })
    const first = mount({ kind: 'resource', ref: { kind: 'finding', id: 'f1' } }, vi.fn().mockResolvedValue(finding()), navigation, memory)
    const add = screen.getByRole('button', { name: 'Add to General message' })
    await waitFor(() => expect(add).toBeEnabled())
    fireEvent.click(add)
    expect(draftOf(memory, 'r1')?.references).toHaveLength(1)
    expect(navigation.openPlace).not.toHaveBeenCalled()
    first.unmount()

    memory.set(attachTargetKey('p1'), { filter: null, focusKey: 'composer:general' })
    memory.set(generalDraftKey('p1', null), { ...emptyGeneralDraft(null), body: 'compare with' })
    mount({ kind: 'resource', ref: { kind: 'file', id: 'results/summary.csv' } }, vi.fn().mockResolvedValue(file('aaaaaaaaaaaaaaaa')), navigation, memory)
    const back = screen.getByRole('button', { name: 'Add to message' })
    await waitFor(() => expect(back).toBeEnabled())
    fireEvent.click(back)
    expect(draftOf(memory)).toMatchObject({ body: 'compare with', references: [expect.objectContaining({ seen: 'previewed' })] })
    expect(navigation.openPlace).toHaveBeenCalledWith({ view: 'general', filter: null }, { inspector: 'closed', focus: 'composer:general' })
    expect(memory.get(attachTargetKey('p1'))).toBeNull()
  })

  it('cannot add past the limit, and has nowhere to add from a private conversation', async () => {
    const memory = createPlaceMemory()
    memory.set(generalDraftKey('p1', null), {
      ...emptyGeneralDraft(null),
      references: Array.from({ length: 16 }, (_, index) => ({ ref: { kind: 'finding', id: `x${index}`, revision: '1' }, title: 'x', seen: 'listed' })),
    })
    const navigation = fakeNavigation({ location: { place: { view: 'general' }, inspector: [] } })
    const full = mount({ kind: 'resource', ref: { kind: 'finding', id: 'f1' } }, vi.fn().mockResolvedValue(finding()), navigation, memory)
    await screen.findByText('Accuracy held at 0.91')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add to message' })).toHaveAccessibleDescription('A message can cite up to 16 records.'))
    expect(screen.getByRole('button', { name: 'Add to message' })).toBeDisabled()
    full.unmount()
    mount({ kind: 'resource', ref: { kind: 'finding', id: 'f1' } }, vi.fn().mockResolvedValue(finding()), fakeNavigation({ location: { place: { view: 'dm', member: 'm1' }, inspector: [] } }))
    await screen.findByText('Accuracy held at 0.91')
    expect(screen.queryByRole('button', { name: /Add to/ })).not.toBeInTheDocument()
  })

  it('goes to the Task a record belongs to, and says a Task is only linked', async () => {
    const navigation = fakeNavigation()
    mount({ kind: 'resource', ref: { kind: 'finding', id: 'f1' } }, vi.fn().mockResolvedValue(finding()), navigation)
    fireEvent.click(await screen.findByRole('button', { name: 'Open Task' }))
    expect(navigation.inspect).toHaveBeenCalledWith({ kind: 'task', id: 'r1' }, { mode: 'push' })
  })

  it('says a Task attached only links the message', async () => {
    const read = vi.fn().mockResolvedValue(finding({ ref: { kind: 'research', id: 'r2', revision: '3' }, title: 'Prune heads', shown_revision: '3' }))
    mount({ kind: 'resource', ref: { kind: 'research', id: 'r2' } }, read)
    expect(await screen.findByText("Attaching a Task links your message to it. It doesn't approve or start anything.")).toBeInTheDocument()
  })

  /** Shows version aaaa, which then changes while more is loading; the next read is `next`. */
  async function readAgain(next: () => Promise<ProjectContextDocument>) {
    const read = vi.fn()
      .mockResolvedValueOnce({ ...file('aaaaaaaaaaaaaaaa'), next_cursor: 'c1' })
      .mockResolvedValueOnce({ ...file('aaaaaaaaaaaaaaaa'), availability: 'changed', sections: [], next_cursor: null, shown_revision: null })
      .mockImplementationOnce(next)
    const navigation = fakeNavigation({ location: { place: { view: 'general' }, inspector: [] } })
    const view = mount({ kind: 'resource', ref: { kind: 'file', id: 'results/summary.csv' } }, read, navigation)
    const add = screen.getByRole('button', { name: 'Add to message' })
    await waitFor(() => expect(add).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Show the current version' }))
    return { ...view, add }
  }

  it('offers nothing while it reads the current version again, then only the version that shows', async () => {
    let finish: (doc: ProjectContextDocument) => void = () => undefined
    const { add, memory } = await readAgain(() => new Promise((resolve) => { finish = resolve }))
    await waitFor(() => expect(add).toBeDisabled())
    expect(add).toHaveAccessibleDescription('Available once the preview has loaded.')
    finish(file('bbbbbbbbbbbbbbbb'))
    await waitFor(() => expect(add).toBeEnabled())
    fireEvent.click(add)
    expect(draftOf(memory)?.references).toEqual([
      { ref: { kind: 'file', id: 'results/summary.csv', revision: 'bbbbbbbbbbbbbbbb' }, title: 'results/summary.csv', seen: 'previewed' },
    ])
  })

  it('offers nothing once the record is gone, though a version was shown before', async () => {
    await readAgain(() => Promise.resolve({ ...file('cccccccccccccccc'), availability: 'removed' as const, sections: [] }))
    expect(await screen.findByText('This item is no longer available.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add to message' })).not.toBeInTheDocument()
  })

  it('offers nothing once the record cannot be read, though a version was shown before', async () => {
    const { add } = await readAgain(() => Promise.reject(new Error('offline')))
    expect(await screen.findByText('Could not load this record.')).toBeInTheDocument()
    expect(add).toBeDisabled()
  })

  it('opens a cited record at the version it was cited, and says when it changed since', async () => {
    mount({ kind: 'resource', ref: { kind: 'file', id: 'results/summary.csv', revision: 'aaaaaaaaaaaaaaaa' } }, vi.fn().mockResolvedValue(file('bbbbbbbbbbbbbbbb')))
    expect(await screen.findByText('Cited version: #aaaaaaa')).toBeInTheDocument()
    expect(screen.getByText('Changed since it was cited.')).toBeInTheDocument()
  })

  it('says a Task replaces the one the message was about, and keeps the version shown', async () => {
    const read = vi.fn().mockResolvedValue(finding({ ref: { kind: 'research', id: 'r2', revision: '3' }, title: 'Prune heads', shown_revision: '3' }))
    const navigation = fakeNavigation({ location: { place: { view: 'general', filter: 'r1' }, inspector: [] } })
    const { memory } = mount({ kind: 'resource', ref: { kind: 'research', id: 'r2' } }, read, navigation)
    const add = screen.getByRole('button', { name: 'Add to message' })
    await waitFor(() => expect(add).toBeEnabled())
    fireEvent.click(add)
    expect(draftOf(memory, 'r1')).toMatchObject({ task: 'r2', taskRevision: '3' })
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Your message is now about Prune heads instead of the Task it was about.')
  })

  it('a record that is gone keeps Back and Close and says it is no longer available', async () => {
    const read = vi.fn().mockResolvedValue(finding({ availability: 'removed', sections: [] }))
    mount({ kind: 'resource', ref: { kind: 'artifact', id: 'a1' } }, read)
    expect(await screen.findByText('This item is no longer available.')).toBeInTheDocument()
  })
})
