import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import { ApiError, type ChannelMessage, type KubecodeApi, type ProjectContextRef } from '../api'
import { createPlaceMemory, placeKey, usePlaceState, type PlaceMemory } from '../app/location/placeMemory'
import { PlaceMemoryProvider } from '../app/location/PlaceMemoryProvider'
import { memberDirectory, type MemberDirectory } from '../members/memberDirectory'
import { analyst, channelMessage, general, member, writer } from '../members/memberFixtures'
import { localReferenceLabels } from '../references/referenceLabels'
import type { AddContextDialogProps } from '../resources/AddContextDialog'
import type { DraftReference } from '../resources/draftReferences'
import { ReferenceResolverProvider } from '../resources/ReferenceResolverProvider'
import { emptyGeneralDraft, type GeneralDraft } from './generalDraft'
import { MessageComposer, type MessageComposerProps } from './MessageComposer'

const pickable = (kind: 'research' | 'artifact', id: string, title: string, revision = '3'): DraftReference => ({
  ref: { kind, id, revision },
  title,
  seen: 'previewed',
})

// Add context is covered by its own tests; here it only hands back a versioned reference and closes.
vi.mock('../resources/AddContextDialog', () => ({
  AddContextDialog: ({ onAttach, onCloseAutoFocus, onOpenChange, open }: AddContextDialogProps) => {
    if (!open) return null
    const pick = (reference: DraftReference) => {
      onAttach(reference)
      onOpenChange(false)
      onCloseAutoFocus?.(new Event('close'))
    }
    return (
      <div>
        <button type="button" onClick={() => pick(pickable('artifact', 'a1', 'results.csv'))}>pick results</button>
        <button type="button" onClick={() => pick(pickable('artifact', 'a1', 'results.csv', '4'))}>pick newer results</button>
        <button type="button" onClick={() => pick(pickable('artifact', 'a2', 'plot.png'))}>pick plot</button>
        <button type="button" onClick={() => pick(pickable('research', 'r2', 'Quantization'))}>pick Quantization</button>
      </div>
    )
  },
}))

const t = createTranslator('en')
const unready = member({ id: 'u', name: 'Unready', handle: 'unready', state: 'setup_required', public_conversation_id: null })
const team = memberDirectory({ members: [general, analyst, writer, unready], general_id: 'g' }, 'ready')
const saved = (body = 'saved') => channelMessage(9, { body })

type Extra = Partial<Omit<MessageComposerProps, 'draft' | 'onDraftChange'>> & { initial?: GeneralDraft; draftKey?: string }

function Harness({ draftKey = placeKey.general('p1'), initial = emptyGeneralDraft(null), ...extra }: Extra) {
  const [draft, setDraft] = usePlaceState(`${draftKey}#draft`, initial)
  return (
    <MessageComposer
      api={{} as unknown as KubecodeApi}
      directory={team}
      draft={draft}
      focusKey="composer:general"
      labels={localReferenceLabels({ research: [{ id: 'r1', title: 'Pruning' }, { id: 'r2', title: 'Quantization' }] as never, threads: [], sessions: [], picked: [], t })}
      placeholder="Message the Workspace"
      projectId="p1"
      t={t}
      outboxKey={`${draftKey}#outbox`}
      onDraftChange={setDraft}
      onSend={vi.fn().mockResolvedValue(saved())}
      {...extra}
    />
  )
}

function placed(memory: PlaceMemory, children: ReactNode) {
  return <PlaceMemoryProvider memory={memory}>{children}</PlaceMemoryProvider>
}

// With no member to suggest, the text box is a plain textbox rather than a combobox.
const box = () => (screen.queryByRole('combobox', { name: 'Message the Workspace' })
  ?? screen.getByRole('textbox', { name: 'Message the Workspace' })) as HTMLTextAreaElement
const toRow = () => document.querySelector('.kubecode-composer-to') as HTMLElement | null
// What still needs the researcher (members loading or failed, nobody can receive): shown in the card.
const notice = () => document.querySelector('.kubecode-composer-notice') as HTMLElement
const type = (value: string) => fireEvent.change(box(), { target: { value, selectionStart: value.length } })

/** Add context is a menu (ADR 0242): attach from the Workspace, or mention someone. */
async function addContext(item = 'Attach from this Workspace…') {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Add context' }), { button: 0, ctrlKey: false, pointerType: 'mouse' })
  fireEvent.click(await screen.findByRole('menuitem', { name: item }))
}

describe('MessageComposer', () => {
  it('has no message type, no recipient row and no hint line: the card is quiet', async () => {
    render(<Harness />)
    expect(screen.queryByRole('combobox', { name: 'Message type' })).not.toBeInTheDocument()
    expect(screen.queryByText('Ask a Session')).not.toBeInTheDocument()
    expect(toRow()).toBeNull()
    expect(screen.queryByText(/never start work/)).not.toBeInTheDocument()
    expect(screen.queryByText('Project manager')).not.toBeInTheDocument()
    expect(box()).not.toHaveAccessibleDescription(/never start work/)
    // Empty, the card is compact: two lines that grow with the text.
    expect(box()).toHaveAttribute('rows', '2')
  })

  it('sends to the mentioned members without a recipient row in the card', async () => {
    const onSend = vi.fn().mockResolvedValue(saved())
    render(<Harness onSend={onSend} />)
    type('@analyst please look, cc thanks')
    expect(toRow()).toBeNull()
    expect(screen.queryByRole('list', { name: 'To' })).not.toBeInTheDocument()
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    expect(onSend.mock.calls[0][0]).toMatchObject({
      body: '@analyst please look, cc thanks',
      mentions: [{ member_id: 'a' }],
      replyTo: null,
    })
    expect(onSend.mock.calls[0][0]).not.toHaveProperty('intent')
    expect(onSend.mock.calls[0][0]).not.toHaveProperty('threadId')
  })

  it('blocks a draft naming a member who cannot receive, and says why on Send', async () => {
    render(<Harness />)
    type('@unready can you?')
    const send = screen.getByRole('button', { name: 'Send' })
    expect(send).toBeDisabled()
    const reason = "Unready can't receive messages yet (Needs setup). Remove the mention, or fix Unready in Members."
    expect(send).toHaveAccessibleDescription(reason)
    expect(screen.getAllByText(reason).some((element) => element.getAttribute('role') === 'status')).toBe(true)
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  it('blocks sending while the members load, without saying the project manager needs setup', async () => {
    const onSend = vi.fn()
    render(<Harness directory={memberDirectory(null, 'loading')} onSend={onSend} />)
    type('@analyst hello')
    const send = screen.getByRole('button', { name: 'Send' })
    expect(send).toBeDisabled()
    expect(send).toHaveAccessibleDescription('Send is available once the members have loaded, so Kubecode knows whom this goes to.')
    expect(notice()).toHaveTextContent('Loading members…')
    expect(screen.queryByText(/needs setup/)).not.toBeInTheDocument()
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    expect(box().value).toBe('@analyst hello')
  })

  it('blocks sending when the members could not be loaded, and offers to load them again', async () => {
    const reload = vi.fn()
    const onSend = vi.fn()
    render(<Harness directory={{ ...memberDirectory(null, 'error'), reload }} onSend={onSend} />)
    type('hello')
    const reason = "The members could not be loaded, so Kubecode can't tell whom this goes to. Try again before sending."
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAccessibleDescription(reason)
    expect(screen.getAllByText(reason).some((element) => element.getAttribute('role') === 'status')).toBe(true)
    expect(screen.queryByText(/needs setup/)).not.toBeInTheDocument()
    fireEvent.click(within(notice()).getByRole('button', { name: 'Try again' }))
    expect(reload).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('blocks a draft that names no one while the project manager needs setup, and sends one that names a member', async () => {
    const onSend = vi.fn().mockResolvedValue(saved())
    const manager = { ...general, state: 'setup_required' as const, public_conversation_id: null }
    render(<Harness directory={memberDirectory({ members: [manager, analyst], general_id: 'g' }, 'ready')} onSend={onSend} />)
    type('anyone?')
    expect(notice()).toHaveTextContent('No one can receive this yet: the project manager needs setup.')
    const send = screen.getByRole('button', { name: 'Send' })
    expect(send).toBeDisabled()
    expect(send).toHaveAccessibleDescription(
      "The project manager can't receive messages yet. @mention a member who can, or fix the project manager in Members.",
    )
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    type('@analyst anyone?')
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
  })

  it('blocks a draft naming a removed member instead of sending it to the project manager', async () => {
    const gone = member({ id: 'old', name: 'Old', handle: 'old', state: 'removed', public_conversation_id: null })
    const onSend = vi.fn()
    render(<Harness directory={memberDirectory({ members: [general, analyst, gone], general_id: 'g' }, 'ready')} onSend={onSend} />)
    type('@old are you there?')
    expect(toRow()).toBeNull()
    const send = screen.getByRole('button', { name: 'Send' })
    expect(send).toBeDisabled()
    expect(send).toHaveAccessibleDescription('Old was removed and can no longer receive messages. Remove the mention.')
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('does not send on Shift+Enter or while an input method composes', async () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    type('hello')
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true })
    fireEvent.compositionStart(box())
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('shows the Task it is about, sent first, and lets the researcher take it off', async () => {
    const onSend = vi.fn().mockResolvedValue(saved())
    render(<Harness initial={emptyGeneralDraft('r1')} onSend={onSend} />)
    const about = document.querySelector('.kubecode-composer-about') as HTMLElement
    expect(about).toHaveTextContent('About')
    expect(within(about).getByText('Pruning')).toBeInTheDocument()
    await addContext()
    fireEvent.click(await screen.findByRole('button', { name: 'pick results' }))
    type('see this')
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    expect(onSend.mock.calls[0][0].references).toEqual([
      { kind: 'research', id: 'r1', revision: null },
      { kind: 'artifact', id: 'a1', revision: '3' },
    ])
    // The Task stays for the next message; its references were sent.
    expect(within(document.querySelector('.kubecode-composer-about') as HTMLElement).queryByText('results.csv')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Not about Pruning' }))
    expect(document.querySelector('.kubecode-composer-about')).toBeNull()
    expect(box()).toHaveFocus()
  })

  it('makes a research question picked as context the Task, and adds other picks once', async () => {
    render(<Harness />)
    for (const name of ['pick results', 'pick results', 'pick plot', 'pick Quantization']) {
      await addContext()
      fireEvent.click(await screen.findByRole('button', { name }))
    }
    const about = document.querySelector('.kubecode-composer-about') as HTMLElement
    expect(about.querySelectorAll('.kubecode-reference-chip')).toHaveLength(3)
    expect(within(about).getByText('Quantization')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove reference results.csv' }))
    expect(about.querySelectorAll('.kubecode-reference-chip')).toHaveLength(2)
  })

  it('names each attached reference by kind, title and version, replaces another version, and announces it', async () => {
    render(<Harness />)
    await addContext()
    fireEvent.click(await screen.findByRole('button', { name: 'pick results' }))
    expect(screen.getByText('Added results.csv to your message.')).toBeInTheDocument()
    const about = document.querySelector('.kubecode-composer-about') as HTMLElement
    expect(within(about).getByText('v3')).toBeInTheDocument()
    await addContext()
    fireEvent.click(await screen.findByRole('button', { name: 'pick newer results' }))
    expect(about.querySelectorAll('.kubecode-reference-chip')).toHaveLength(1)
    expect(within(about).getByText('v4')).toBeInTheDocument()
    expect(screen.getByText('Updated results.csv to the version you previewed.')).toBeInTheDocument()
  })

  it('puts the caret back where it was when Add context closes', async () => {
    render(<Harness />)
    type('compare with the baseline')
    box().setSelectionRange(8, 8)
    await addContext()
    box().setSelectionRange(0, 0)
    fireEvent.click(await screen.findByRole('button', { name: 'pick results' }))
    expect(box()).toHaveFocus()
    expect(box().selectionStart).toBe(8)
    expect(box().value).toBe('compare with the baseline')
  })

  it('will not send a reference to something that no longer exists, and says which', async () => {
    const onSend = vi.fn().mockResolvedValue(saved())
    const resolveProjectContext = vi.fn().mockImplementation((_p: string, refs: ProjectContextRef[]) => Promise.resolve(refs.map((ref) => ({
      ref, availability: ref.id === 'a1' ? 'removed' : 'available', current_revision: null, title: null,
    }))))
    const initial: GeneralDraft = { ...emptyGeneralDraft(null), references: [pickable('artifact', 'a1', 'results.csv'), pickable('artifact', 'a2', 'plot.png')] }
    render(
      <ReferenceResolverProvider api={{ resolveProjectContext } as unknown as KubecodeApi} events={[]} projectId="p1">
        <Harness initial={initial} onSend={onSend} />
      </ReferenceResolverProvider>,
    )
    expect(await screen.findByText('No longer exists')).toBeInTheDocument()
    type('see these')
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(await screen.findByRole('alert')).toHaveTextContent('results.csv no longer exists. Remove it to send.')
    expect(onSend).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove reference results.csv' })).toHaveFocus())
    fireEvent.click(screen.getByRole('button', { name: 'Remove reference results.csv' }))
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    expect(onSend.mock.calls[0][0].references).toEqual([{ kind: 'artifact', id: 'a2', revision: '3' }])
  })

  it('is one input surface: the reply and references head the card, and the text and its controls fill it', async () => {
    const initial = { ...emptyGeneralDraft('r1'), reply: { messageId: 'm4', authorName: 'Analyst', excerpt: 'Ran it' } }
    render(<Harness initial={initial} />)
    const card = document.querySelector('.kubecode-prompt-input') as HTMLElement
    expect(card).not.toBeNull()
    const header = card.querySelector('.kubecode-composer-context') as HTMLElement
    expect(header).toHaveTextContent('Replying to Analyst: Ran it')
    expect(within(header).getByText('Pruning')).toBeInTheDocument()
    expect(card).toContainElement(box())
    expect(within(card).getByRole('button', { name: 'Add context' })).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Send' })).toBeInTheDocument()
    expect(card).not.toHaveTextContent(/never start work/)
    expect(toRow()).toBeNull()
  })

  it('puts "@" at the caret for a mention', async () => {
    render(<Harness />)
    type('hi')
    box().setSelectionRange(2, 2)
    await addContext('Mention someone')
    expect(box().value).toBe('hi @')
    await waitFor(() => expect(box()).toHaveFocus())
  })

  it('cancels a reply with its own button and keeps Escape for the text box', async () => {
    const initial = { ...emptyGeneralDraft(null), reply: { messageId: 'm4', authorName: 'Analyst', excerpt: 'Ran it' } }
    render(<Harness initial={initial} />)
    expect(screen.getByText('Replying to Analyst: Ran it')).toBeInTheDocument()
    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(screen.getByText('Replying to Analyst: Ran it')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel reply' }))
    expect(screen.queryByText(/Replying to/)).not.toBeInTheDocument()
    expect(box()).toHaveFocus()
  })

  it('names a dropped connection in the interface language, never the browser\'s raw fetch error', async () => {
    const onSend = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch'))
    render(<Harness initial={emptyGeneralDraft(null)} onSend={onSend} onSent={vi.fn()} />)
    type('hello')
    fireEvent.keyDown(box(), { key: 'Enter' })
    const unsent = await screen.findByRole('list', { name: 'Unsent messages' })
    const alert = await within(unsent).findByRole('alert')
    expect(alert).toHaveTextContent('Not sent: Something went wrong')
    expect(alert).not.toHaveTextContent('Failed to fetch')
  })

  it('keeps a failed send as its own row: Send again replays the same id, and what is typed since is never touched', async () => {
    // The first save committed on the server, but its answer was lost.
    const onSend = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(saved())
    const onSent = vi.fn()
    const initial: GeneralDraft = {
      ...emptyGeneralDraft('r1'),
      reply: { messageId: 'm4', authorName: 'Analyst', excerpt: 'Ran it' },
      references: [pickable('artifact', 'a1', 'results.csv')],
    }
    render(<Harness initial={initial} onSend={onSend} onSent={onSent} />)
    type('@analyst thanks')
    fireEvent.keyDown(box(), { key: 'Enter' })
    const unsent = await screen.findByRole('list', { name: 'Unsent messages' })
    expect(await within(unsent).findByRole('alert')).toHaveTextContent('Not sent: network down')
    expect(unsent).toHaveTextContent('@analyst thanks')
    // The composer is free at once, and its new words are never merged with the failed send.
    expect(box()).toHaveValue('')
    type('next thought')
    expect(within(unsent).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    fireEvent.click(within(unsent).getByRole('button', { name: 'Send again' }))
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2))
    // The same client id: the server answers with the message it already saved, never a second one.
    expect(onSend.mock.calls[1][0].clientMessageId).toBe(onSend.mock.calls[0][0].clientMessageId)
    expect(onSend.mock.calls[1][0]).toMatchObject({ body: '@analyst thanks', replyTo: 'm4', mentions: [{ member_id: 'a' }] })
    await waitFor(() => expect(onSent).toHaveBeenCalledWith(saved()))
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Unsent messages' })).not.toBeInTheDocument())
    expect(box()).toHaveValue('next thought')
  })

  it('sends while an earlier send is still on its way, each under its own id', async () => {
    let answer: (message: ChannelMessage) => void = () => undefined
    const onSend = vi.fn()
      .mockImplementationOnce(() => new Promise<ChannelMessage>((resolve) => { answer = resolve }))
      .mockResolvedValue(saved())
    render(<Harness onSend={onSend} />)
    type('first')
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(await screen.findByText('Sending…')).toBeInTheDocument()
    type('second')
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2))
    expect(onSend.mock.calls[1][0].clientMessageId).not.toBe(onSend.mock.calls[0][0].clientMessageId)
    answer(saved('first'))
    await waitFor(() => expect(screen.queryByText('Sending…')).not.toBeInTheDocument())
  })

  it('puts a failed send back in the empty composer on Edit, as a new message from then on', async () => {
    const onSend = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(saved())
    render(<Harness initial={{ ...emptyGeneralDraft(null), reply: { messageId: 'm4', authorName: 'Analyst', excerpt: 'Ran it' } }} onSend={onSend} />)
    type('first wording')
    fireEvent.keyDown(box(), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    expect(box()).toHaveValue('first wording')
    expect(screen.getByText('Replying to Analyst: Ran it')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Unsent messages' })).not.toBeInTheDocument()
    type('second wording')
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2))
    expect(onSend.mock.calls[1][0].clientMessageId).not.toBe(onSend.mock.calls[0][0].clientMessageId)
  })

  it('sends a failed send with a versioned reference again under the same id, citing the same versions, once', async () => {
    const onSend = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(saved())
    const initial: GeneralDraft = { ...emptyGeneralDraft(null), task: 'r1', taskRevision: '2' }
    render(<Harness initial={initial} onSend={onSend} />)
    await addContext()
    fireEvent.click(await screen.findByRole('button', { name: 'pick newer results' }))
    type('compare with v4')
    fireEvent.keyDown(box(), { key: 'Enter' })
    const unsent = await screen.findByRole('list', { name: 'Unsent messages' })
    expect(await within(unsent).findByRole('alert')).toHaveTextContent('Not sent: network down')
    const pinned = [
      { kind: 'research', id: 'r1', revision: '2' },
      { kind: 'artifact', id: 'a1', revision: '4' },
    ]
    expect(onSend.mock.calls[0][0].references).toEqual(pinned)
    // Meanwhile the next message attaches the earlier version of the same file.
    await addContext()
    fireEvent.click(await screen.findByRole('button', { name: 'pick results' }))
    fireEvent.click(within(unsent).getByRole('button', { name: 'Send again' }))
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Unsent messages' })).not.toBeInTheDocument())
    expect(onSend).toHaveBeenCalledTimes(2)
    const [first, again] = onSend.mock.calls.map(([message]) => message)
    expect(again.clientMessageId).toBe(first.clientMessageId)
    expect(again).toEqual(first)
    expect(again.references).toEqual(pinned)
    // The new draft keeps its own version.
    const about = document.querySelector('.kubecode-composer-about') as HTMLElement
    expect(within(about).getByText('v3')).toBeInTheDocument()
  })

  it('puts a failed send back on Edit with the versions it was attached at, Task included', async () => {
    const onSend = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(saved())
    render(<Harness initial={{ ...emptyGeneralDraft(null), task: 'r1', taskRevision: '2' }} onSend={onSend} />)
    await addContext()
    fireEvent.click(await screen.findByRole('button', { name: 'pick newer results' }))
    type('first wording')
    fireEvent.keyDown(box(), { key: 'Enter' })
    await screen.findByRole('button', { name: 'Edit' })
    // The Task is taken off the next message before the failed one is edited.
    fireEvent.click(screen.getByRole('button', { name: 'Not about Pruning' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(within(document.querySelector('.kubecode-composer-about') as HTMLElement).getByText('v4')).toBeInTheDocument()
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2))
    expect(onSend.mock.calls[1][0].clientMessageId).not.toBe(onSend.mock.calls[0][0].clientMessageId)
    expect(onSend.mock.calls[1][0].references).toEqual([
      { kind: 'research', id: 'r1', revision: '2' },
      { kind: 'artifact', id: 'a1', revision: '4' },
    ])
  })

  it('forgets a discarded send, so the same words typed later are a new message', async () => {
    const onSend = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(saved())
    render(<Harness onSend={onSend} />)
    type('ship it')
    fireEvent.keyDown(box(), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }))
    expect(screen.queryByRole('list', { name: 'Unsent messages' })).not.toBeInTheDocument()
    type('ship it')
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2))
    expect(onSend.mock.calls[1][0].clientMessageId).not.toBe(onSend.mock.calls[0][0].clientMessageId)
  })

  it('keeps a Task chosen while the send was in flight when the send fails', async () => {
    let fail: (cause: Error) => void = () => undefined
    const onSend = vi.fn(() => new Promise<ChannelMessage>((_, reject) => { fail = reject }))
    render(<Harness initial={emptyGeneralDraft('r1')} onSend={onSend} />)
    type('in flight')
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    await addContext()
    fireEvent.click(await screen.findByRole('button', { name: 'pick Quantization' }))
    fail(new Error('network down'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Not sent: network down')
    expect(box()).toHaveValue('')
    expect(screen.getByRole('list', { name: 'Unsent messages' })).toHaveTextContent('in flight')
    const about = document.querySelector('.kubecode-composer-about') as HTMLElement
    expect(within(about).getByText('Quantization')).toBeInTheDocument()
  })

  it('keeps the draft and reads the members again when the server says a mention cannot receive', async () => {
    const reload = vi.fn()
    const directory: MemberDirectory = { ...team, reload }
    const onSend = vi.fn().mockRejectedValue(new ApiError('mention_unavailable', 'no', 400, null, 'needs_setup', 'w'))
    render(<Harness directory={directory} onSend={onSend} />)
    type('@writer draft the summary')
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Writer can no longer receive messages. Your message was kept; remove the mention or fix Writer in Members.',
    )
    expect(reload).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(box().value).toBe('@writer draft the summary')
  })

  it('names no one as "@" when the server refuses a mention of a member it does not know', async () => {
    const onSend = vi.fn().mockRejectedValue(new ApiError('mention_unavailable', 'no', 400, null, 'removed', 'gone-id'))
    render(<Harness onSend={onSend} />)
    type('@writer draft the summary')
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A member you mentioned can no longer receive messages. Your message was kept; check the mentions, or Members.',
    )
    expect(screen.getByRole('alert')).not.toHaveTextContent(/^@ /)
  })

  it('offers a named stop that does not block sending', async () => {
    const onStop = vi.fn()
    render(<Harness stop={{ label: "Stop Analyst's current turn", shortLabel: 'Stop', onStop }} />)
    fireEvent.click(screen.getByRole('button', { name: "Stop Analyst's current turn" }))
    expect(onStop).toHaveBeenCalledTimes(1)
  })
})

describe('MessageComposer drafts kept for the place (ADR 0228 §4, ADR 0229 §6)', () => {
  it('keeps the draft of General and of each Task-scoped General apart, across leaving and coming back', async () => {
    const memory = createPlaceMemory()
    const view = render(placed(memory, <Harness />))
    type('half a thought')
    view.rerender(placed(memory, <p>elsewhere</p>))
    view.rerender(placed(memory, <Harness />))
    expect(box()).toHaveValue('half a thought')
    view.rerender(placed(memory, <Harness draftKey={placeKey.general('p1', 'r1')} initial={emptyGeneralDraft('r1')} />))
    expect(box()).toHaveValue('')
  })

  it('keeps a send that fails after the place was left as its row there, and sends it again under the same id', async () => {
    const memory = createPlaceMemory()
    let fail: (cause: Error) => void = () => undefined
    const onSend = vi.fn()
      .mockImplementationOnce(() => new Promise<ChannelMessage>((_, reject) => { fail = reject }))
      .mockResolvedValue(saved())
    const view = render(placed(memory, <Harness onSend={onSend} />))
    type('in flight')
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    view.rerender(placed(memory, <p>elsewhere</p>))
    fail(new Error('network down'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    view.rerender(placed(memory, <Harness onSend={onSend} />))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Not sent: network down')
    expect(box()).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: 'Send again' }))
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2))
    expect(onSend.mock.calls[1][0].clientMessageId).toBe(onSend.mock.calls[0][0].clientMessageId)
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })
})
