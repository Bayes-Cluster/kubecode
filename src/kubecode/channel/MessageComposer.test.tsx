import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import { ApiError, type ChannelMessage, type KubecodeApi, type ProjectContextItem } from '../api'
import { createPlaceMemory, placeKey, usePlaceState, type PlaceMemory } from '../app/location/placeMemory'
import { PlaceMemoryProvider } from '../app/location/PlaceMemoryProvider'
import { memberDirectory, type MemberDirectory } from '../members/memberDirectory'
import { analyst, channelMessage, general, member, writer } from '../members/memberFixtures'
import { localReferenceLabels } from '../references/referenceLabels'
import { emptyGeneralDraft, type GeneralDraft } from './generalDraft'
import { MessageComposer, type MessageComposerProps } from './MessageComposer'

const pickable = (kind: 'research' | 'artifact', id: string, title: string) => ({
  ref: { kind, id, revision: '3' },
  title,
}) as unknown as ProjectContextItem

// The picker is covered by its own tests; here it only hands back a reference.
vi.mock('../ComposerProjectWorkPicker', () => ({
  ComposerProjectWorkPicker: ({ onSelect }: { onSelect: (item: ProjectContextItem) => void }) => (
    <div>
      <button type="button" onClick={() => onSelect(pickable('artifact', 'a1', 'results.csv'))}>pick results</button>
      <button type="button" onClick={() => onSelect(pickable('artifact', 'a2', 'plot.png'))}>pick plot</button>
      <button type="button" onClick={() => onSelect(pickable('research', 'r2', 'Quantization'))}>pick Quantization</button>
    </div>
  ),
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
const toRow = () => document.querySelector('.kubecode-composer-to') as HTMLElement
const type = (value: string) => fireEvent.change(box(), { target: { value, selectionStart: value.length } })

describe('MessageComposer', () => {
  it('has no message type: every message is plain, and the To row says it goes to the project manager', () => {
    render(<Harness />)
    expect(screen.queryByRole('combobox', { name: 'Message type' })).not.toBeInTheDocument()
    expect(screen.queryByText('Ask a Session')).not.toBeInTheDocument()
    expect(toRow()).toHaveTextContent('To')
    expect(toRow()).toHaveTextContent(/General.*Project manager/)
    expect(screen.getByText(/never start work/)).toBeInTheDocument()
    expect(box()).toHaveAccessibleDescription(/never start work/)
  })

  it('shows the mentioned members as recipients, and removing one takes the mention out of the text', async () => {
    const onSend = vi.fn().mockResolvedValue(saved())
    render(<Harness onSend={onSend} />)
    type('@analyst please look, cc @writer thanks')
    const recipients = within(toRow()).getByRole('list', { name: 'To' })
    expect(recipients).toHaveTextContent(/Analyst.*Writer/)
    fireEvent.click(screen.getByRole('button', { name: "Don't send to Writer" }))
    expect(box().value).toBe('@analyst please look, cc thanks')
    expect(toRow()).not.toHaveTextContent('Writer')
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

  it('blocks a draft naming a member who cannot receive, and says why on Send', () => {
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

  it('blocks sending while the members load, without saying the project manager needs setup', () => {
    const onSend = vi.fn()
    render(<Harness directory={memberDirectory(null, 'loading')} onSend={onSend} />)
    type('@analyst hello')
    const send = screen.getByRole('button', { name: 'Send' })
    expect(send).toBeDisabled()
    expect(send).toHaveAccessibleDescription('Send is available once the members have loaded, so Kubecode knows whom this goes to.')
    expect(toRow()).toHaveTextContent('Loading members…')
    expect(screen.queryByText(/needs setup/)).not.toBeInTheDocument()
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    expect(box().value).toBe('@analyst hello')
  })

  it('blocks sending when the members could not be loaded, and offers to load them again', () => {
    const reload = vi.fn()
    const onSend = vi.fn()
    render(<Harness directory={{ ...memberDirectory(null, 'error'), reload }} onSend={onSend} />)
    type('hello')
    const reason = "The members could not be loaded, so Kubecode can't tell whom this goes to. Try again before sending."
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAccessibleDescription(reason)
    expect(screen.getAllByText(reason).some((element) => element.getAttribute('role') === 'status')).toBe(true)
    expect(screen.queryByText(/needs setup/)).not.toBeInTheDocument()
    fireEvent.click(within(toRow()).getByRole('button', { name: 'Try again' }))
    expect(reload).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('blocks a draft that names no one while the project manager needs setup, and sends one that names a member', async () => {
    const onSend = vi.fn().mockResolvedValue(saved())
    const manager = { ...general, state: 'setup_required' as const, public_conversation_id: null }
    render(<Harness directory={memberDirectory({ members: [manager, analyst], general_id: 'g' }, 'ready')} onSend={onSend} />)
    type('anyone?')
    expect(toRow()).toHaveTextContent('No one can receive this yet: the project manager needs setup.')
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

  it('blocks a draft naming a removed member instead of sending it to the project manager', () => {
    const gone = member({ id: 'old', name: 'Old', handle: 'old', state: 'removed', public_conversation_id: null })
    const onSend = vi.fn()
    render(<Harness directory={memberDirectory({ members: [general, analyst, gone], general_id: 'g' }, 'ready')} onSend={onSend} />)
    type('@old are you there?')
    expect(within(toRow()).getByRole('list', { name: 'To' })).toHaveTextContent(/Old.*Removed/)
    expect(toRow()).not.toHaveTextContent('Project manager')
    const send = screen.getByRole('button', { name: 'Send' })
    expect(send).toBeDisabled()
    expect(send).toHaveAccessibleDescription('Old was removed and can no longer receive messages. Remove the mention.')
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('does not send on Shift+Enter or while an input method composes', () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
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
      fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
      fireEvent.click(await screen.findByRole('button', { name }))
    }
    const about = document.querySelector('.kubecode-composer-about') as HTMLElement
    expect(about.querySelectorAll('.kubecode-reference-chip')).toHaveLength(3)
    expect(within(about).getByText('Quantization')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove reference results.csv' }))
    expect(about.querySelectorAll('.kubecode-reference-chip')).toHaveLength(2)
  })

  it('puts "@" at the caret for a mention', () => {
    render(<Harness />)
    type('hi')
    box().setSelectionRange(2, 2)
    fireEvent.click(screen.getByRole('button', { name: 'Mention someone' }))
    expect(box().value).toBe('hi @')
    expect(box()).toHaveFocus()
  })

  it('cancels a reply with its own button and keeps Escape for the text box', () => {
    const initial = { ...emptyGeneralDraft(null), reply: { messageId: 'm4', authorName: 'Analyst', excerpt: 'Ran it' } }
    render(<Harness initial={initial} />)
    expect(screen.getByText('Replying to Analyst: Ran it')).toBeInTheDocument()
    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(screen.getByText('Replying to Analyst: Ran it')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel reply' }))
    expect(screen.queryByText(/Replying to/)).not.toBeInTheDocument()
    expect(box()).toHaveFocus()
  })

  it('restores the text, reply, Task, references, and recipients after a failed send, and retries on the same id', async () => {
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
    expect(await screen.findByRole('alert')).toHaveTextContent('network down')
    await waitFor(() => expect(box().value).toBe('@analyst thanks'))
    expect(screen.getByText('Replying to Analyst: Ran it')).toBeInTheDocument()
    expect(screen.getByText('results.csv')).toBeInTheDocument()
    expect(within(toRow()).getByRole('list', { name: 'To' })).toHaveTextContent('Analyst')
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2))
    expect(onSend.mock.calls[1][0].clientMessageId).toBe(onSend.mock.calls[0][0].clientMessageId)
    expect(onSend.mock.calls[1][0]).toMatchObject({ replyTo: 'm4', mentions: [{ member_id: 'a' }] })
    await waitFor(() => expect(onSent).toHaveBeenCalledWith(saved()))
    expect(box().value).toBe('')
  })

  it('sends an edited draft as a new message', async () => {
    const onSend = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(saved())
    render(<Harness onSend={onSend} />)
    type('first wording')
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(box().value).toBe('first wording'))
    type('second wording')
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2))
    expect(onSend.mock.calls[1][0].clientMessageId).not.toBe(onSend.mock.calls[0][0].clientMessageId)
  })

  it('forgets a failed attempt once the text is emptied by hand, so the same words typed later are a new message', async () => {
    const onSend = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(saved())
    render(<Harness onSend={onSend} />)
    type('ship it')
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(await screen.findByRole('alert')).toHaveTextContent('network down')
    type('')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
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
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    fireEvent.click(await screen.findByRole('button', { name: 'pick Quantization' }))
    fail(new Error('network down'))
    expect(await screen.findByRole('alert')).toHaveTextContent('network down')
    expect(box()).toHaveValue('in flight')
    const about = document.querySelector('.kubecode-composer-about') as HTMLElement
    expect(within(about).getByText('Quantization')).toBeInTheDocument()
    expect(within(about).queryByText('Pruning')).not.toBeInTheDocument()
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
    expect(box().value).toBe('@writer draft the summary')
    expect(reload).toHaveBeenCalled()
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
    render(<Harness stop={{ target: 'Analyst', onStop }} />)
    fireEvent.click(screen.getByRole('button', { name: /Analyst/ }))
    expect(onStop).toHaveBeenCalledTimes(1)
  })
})

describe('MessageComposer drafts kept for the place (ADR 0228 §4, ADR 0229 §6)', () => {
  it('keeps the draft of General and of each Task-scoped General apart, across leaving and coming back', () => {
    const memory = createPlaceMemory()
    const view = render(placed(memory, <Harness />))
    type('half a thought')
    view.rerender(placed(memory, <p>elsewhere</p>))
    view.rerender(placed(memory, <Harness />))
    expect(box()).toHaveValue('half a thought')
    view.rerender(placed(memory, <Harness draftKey={placeKey.general('p1', 'r1')} initial={emptyGeneralDraft('r1')} />))
    expect(box()).toHaveValue('')
  })

  it('puts a draft back into its place when the send fails after the place was left', async () => {
    const memory = createPlaceMemory()
    let fail: (cause: Error) => void = () => undefined
    const onSend = vi.fn(() => new Promise<ChannelMessage>((_, reject) => { fail = reject }))
    const view = render(placed(memory, <Harness onSend={onSend} />))
    type('in flight')
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    view.rerender(placed(memory, <p>elsewhere</p>))
    fail(new Error('network down'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    view.rerender(placed(memory, <Harness onSend={onSend} />))
    await waitFor(() => expect(box()).toHaveValue('in flight'))
  })

  it('keeps the failure and Try again with the draft when the send fails after the place was left', async () => {
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
    expect(alert).toHaveTextContent('network down')
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2))
    expect(onSend.mock.calls[1][0].clientMessageId).toBe(onSend.mock.calls[0][0].clientMessageId)
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(box()).toHaveValue('')
  })
})
