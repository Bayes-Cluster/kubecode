import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import type { KubecodeApi, ProjectContextDocument, ProjectContextItem } from '../api'
import { fakeNavigation } from '../app/inspector/inspectorTesting'
import { createPlaceMemory, placeKey } from '../app/location/placeMemory'
import { PlaceMemoryProvider } from '../app/location/PlaceMemoryProvider'
import { WorkspaceNavigationContext } from '../app/location/WorkspaceNavigation'
import { AddContextDialog } from './AddContextDialog'
import { attachTargetKey } from './attachTarget'
import type { DraftReference } from './draftReferences'

const t = createTranslator('en')

const fileItem = (availability: ProjectContextItem['availability'] = 'available'): ProjectContextItem => ({
  ref: { kind: 'file', id: 'results/summary.csv', revision: null },
  title: 'results/summary.csv',
  summary: '',
  provenance: { author: null, updated_at: null, research_id: null, parent: null, state: null },
  availability,
})

const fileDoc = (revision: string): ProjectContextDocument => ({
  ref: { kind: 'file', id: 'results/summary.csv', revision },
  detail: 'content',
  title: 'results/summary.csv',
  availability: 'available',
  provenance: { author: null, updated_at: null, research_id: null, parent: null, state: null },
  sections: [{ heading: 'Content', text: 'model,accuracy', truncated: false }],
  related: [],
  next_cursor: null,
  notes: [],
  shown_revision: revision,
})

function mount(api: Partial<KubecodeApi>, memory = createPlaceMemory()) {
  const onAttach = vi.fn<(reference: DraftReference) => 'added'>().mockReturnValue('added')
  const navigation = fakeNavigation()
  const closed = vi.fn()
  function Host() {
    const [open, setOpen] = useState(true)
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>reopen</button>
        <AddContextDialog
          api={api as KubecodeApi}
          events={[]}
          filter="r1"
          full={false}
          has={() => false}
          open={open}
          placeMemoryKey={placeKey.general('p1', 'r1')}
          projectId="p1"
          t={t}
          workspaceName="Pruning lab"
          onAttach={onAttach}
          onCloseAutoFocus={closed}
          onOpenChange={setOpen}
        />
      </>
    )
  }
  render(
    <PlaceMemoryProvider memory={memory}>
      <WorkspaceNavigationContext.Provider value={navigation}>
        <Host />
      </WorkspaceNavigationContext.Provider>
    </PlaceMemoryProvider>,
  )
  return { closed, memory, navigation, onAttach }
}

const search = (items: ProjectContextItem[]) => vi.fn().mockResolvedValue({ items, next_cursor: null, truncated: false })

describe('AddContextDialog', () => {
  it('previews a result, and attaches the version it showed only once it is shown', async () => {
    let finish: (doc: ProjectContextDocument) => void = () => undefined
    const readProjectContext = vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const { onAttach } = mount({ searchProjectContext: search([fileItem()]), readProjectContext })
    expect(screen.getByRole('dialog', { name: 'Add context' })).toHaveTextContent('Choose a result to preview it.')
    const input = screen.getByRole('combobox', { name: 'Search Pruning lab' })
    await screen.findByRole('option', { name: /results\/summary\.csv/ })
    fireEvent.keyDown(input, { key: 'ArrowRight' })
    const attach = await screen.findByRole('button', { name: 'Attach this version' })
    expect(attach).toBeDisabled()
    expect(attach).toHaveAccessibleDescription('Available once the preview has loaded.')
    finish(fileDoc('3f2c1a9e5b7d4c6a'))
    await waitFor(() => expect(attach).toBeEnabled())
    fireEvent.click(attach)
    expect(onAttach).toHaveBeenCalledWith({
      ref: { kind: 'file', id: 'results/summary.csv', revision: '3f2c1a9e5b7d4c6a' }, title: 'results/summary.csv', seen: 'previewed',
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('attaches the current version on Enter, stamped when attached, and refuses one that no longer exists', async () => {
    const resolveProjectContext = vi.fn()
      .mockResolvedValueOnce([{ ref: { kind: 'file', id: 'results/summary.csv' }, availability: 'removed', current_revision: null, title: null }])
      .mockResolvedValue([{ ref: { kind: 'file', id: 'results/summary.csv' }, availability: 'available', current_revision: 'cccccccccccccccc', title: 'results/summary.csv' }])
    const { onAttach } = mount({ searchProjectContext: search([fileItem()]), resolveProjectContext })
    await screen.findByRole('option')
    const input = screen.getByRole('combobox')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByRole('alert')).toHaveTextContent('It no longer exists, so it cannot be added.')
    expect(onAttach).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(onAttach).toHaveBeenCalledWith({
      ref: { kind: 'file', id: 'results/summary.csv', revision: 'cccccccccccccccc' }, title: 'results/summary.csv', seen: 'listed',
    }))
    expect(resolveProjectContext).toHaveBeenCalledWith('p1', [{ kind: 'file', id: 'results/summary.csv' }])
  })

  it('attaches with Ctrl+Enter from the preview, and Escape steps back from the preview before it closes', async () => {
    const { closed, onAttach } = mount({ searchProjectContext: search([fileItem()]), readProjectContext: vi.fn().mockResolvedValue(fileDoc('aaaaaaaaaaaaaaaa')) })
    fireEvent.click(await screen.findByRole('option'))
    const text = await screen.findByText('model,accuracy')
    fireEvent.keyDown(text, { key: 'Escape' })
    expect(await screen.findByText('Choose a result to preview it.')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('option'))
    const shown = await screen.findByText('model,accuracy')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Attach this version' })).toBeEnabled())
    fireEvent.keyDown(shown, { key: 'Enter', ctrlKey: true })
    expect(onAttach).toHaveBeenCalledWith(expect.objectContaining({ seen: 'previewed' }))
    await waitFor(() => expect(closed).toHaveBeenCalled())
  })

  it('keeps the words and the preview for this draft when reopened', async () => {
    mount({ searchProjectContext: search([fileItem()]), readProjectContext: vi.fn().mockResolvedValue(fileDoc('aaaaaaaaaaaaaaaa')) })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'summary' } })
    fireEvent.click(await screen.findByRole('option'))
    await screen.findByText('model,accuracy')
    fireEvent.keyDown(screen.getByText('model,accuracy'), { key: 'Escape' })
    fireEvent.click(screen.getByRole('option'))
    await screen.findByText('model,accuracy')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'reopen' }))
    expect(await screen.findByRole('combobox')).toHaveValue('summary')
    expect(await screen.findByText('model,accuracy')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back to results' })).toBeInTheDocument()
  })

  it('never attaches a version the preview is not showing: choosing another result and coming back reads it again', async () => {
    const other: ProjectContextItem = { ...fileItem(), ref: { kind: 'file', id: 'notes.md', revision: null }, title: 'notes.md' }
    let finishAgain: (doc: ProjectContextDocument) => void = () => undefined
    const readProjectContext = vi.fn()
      .mockResolvedValueOnce(fileDoc('aaaaaaaaaaaaaaaa'))
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockImplementationOnce(() => new Promise((resolve) => { finishAgain = resolve }))
    const { onAttach } = mount({ searchProjectContext: search([fileItem(), other]), readProjectContext })
    fireEvent.click(await screen.findByRole('option', { name: /results\/summary\.csv/ }))
    const attach = await screen.findByRole('button', { name: 'Attach this version' })
    await waitFor(() => expect(attach).toBeEnabled())
    fireEvent.click(screen.getByRole('option', { name: /notes\.md/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Attach this version' })).toBeDisabled())
    // Back to the first: its earlier version is not what is on screen now.
    fireEvent.click(screen.getByRole('option', { name: /results\/summary\.csv/ }))
    expect(await screen.findByText('Loading…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Attach this version' })).toBeDisabled()
    finishAgain(fileDoc('bbbbbbbbbbbbbbbb'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Attach this version' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Attach this version' }))
    expect(onAttach).toHaveBeenCalledWith(expect.objectContaining({ ref: { kind: 'file', id: 'results/summary.csv', revision: 'bbbbbbbbbbbbbbbb' } }))
  })

  it('reopened with the same preview, offers only the version it reads again', async () => {
    let finishAgain: (doc: ProjectContextDocument) => void = () => undefined
    const readProjectContext = vi.fn()
      .mockResolvedValueOnce(fileDoc('aaaaaaaaaaaaaaaa'))
      .mockImplementationOnce(() => new Promise((resolve) => { finishAgain = resolve }))
    const { onAttach } = mount({ searchProjectContext: search([fileItem()]), readProjectContext })
    fireEvent.click(await screen.findByRole('option'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Attach this version' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'reopen' }))
    const attach = await screen.findByRole('button', { name: 'Attach this version' })
    expect(attach).toBeDisabled()
    finishAgain(fileDoc('bbbbbbbbbbbbbbbb'))
    await waitFor(() => expect(attach).toBeEnabled())
    fireEvent.click(attach)
    expect(onAttach).toHaveBeenCalledWith(expect.objectContaining({ ref: { kind: 'file', id: 'results/summary.csv', revision: 'bbbbbbbbbbbbbbbb' } }))
  })

  it('offers nothing for a record the preview finds gone', async () => {
    const readProjectContext = vi.fn().mockResolvedValue({ ...fileDoc('aaaaaaaaaaaaaaaa'), availability: 'removed', sections: [] })
    mount({ searchProjectContext: search([fileItem()]), readProjectContext })
    fireEvent.click(await screen.findByRole('option'))
    expect(await screen.findByText('This record no longer exists.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Attach this version' })).toBeDisabled()
  })

  it('on a narrow screen, Back returns to the results where they were scrolled, with the search box focused', async () => {
    mount({ searchProjectContext: search([fileItem()]), readProjectContext: vi.fn().mockResolvedValue(fileDoc('aaaaaaaaaaaaaaaa')) })
    const option = await screen.findByRole('option')
    const results = screen.getByTestId('search-results')
    results.scrollTop = 120
    fireEvent.click(option)
    await screen.findByText('model,accuracy')
    // Hidden while the preview fills the dialog, the list loses its scroll.
    results.scrollTop = 0
    fireEvent.click(screen.getByRole('button', { name: 'Back to results' }))
    await waitFor(() => expect(results.scrollTop).toBe(120))
    expect(screen.getByRole('combobox')).toHaveFocus()
  })

  it('hands the draft to Resources and says where to return', async () => {
    const { memory, navigation } = mount({ searchProjectContext: search([]) })
    fireEvent.click(screen.getByRole('button', { name: 'Browse in Resources' }))
    expect(memory.get(attachTargetKey('p1'))).toEqual({ filter: 'r1', focusKey: 'composer:general' })
    expect(navigation.openPlace).toHaveBeenCalledWith({ view: 'resources' }, { focus: 'resources:search' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})
