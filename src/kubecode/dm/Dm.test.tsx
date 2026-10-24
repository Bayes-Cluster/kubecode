import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { APP_LOCALES, createTranslator } from '@/lib/i18n'

import type { DmTurn, KubecodeApi, Member, ResearchSummary, WorkspaceEvent } from '../api'
import { ApiError } from '../api'
import { fakeNavigation } from '../app/inspector/inspectorTesting'
import { createPlaceMemory, placeKey, usePlaceState, type PlaceMemory } from '../app/location/placeMemory'
import { PlaceMemoryProvider } from '../app/location/PlaceMemoryProvider'
import { WorkspaceNavigationContext, type WorkspaceNavigation } from '../app/location/WorkspaceNavigation'
import { emptyGeneralDraft, type GeneralDraft } from '../channel/generalDraft'
import { MessageComposer } from '../channel/MessageComposer'
import { localReferenceLabels } from '../references/referenceLabels'
import { memberDirectory, MemberDirectoryContext, type MemberDirectory } from '../members/memberDirectory'
import { channelMessage, general, member } from '../members/memberFixtures'
import { AttentionContext } from '../attention/attentionContext'
import { execution } from '../attention/attentionFixtures'
import { DmPane } from './DmPane'

const t = createTranslator('en')
const analyst: Member = member({ id: 'm1', name: 'Analyst', handle: 'analyst', public_conversation_id: 's-public', dm_conversation_id: 's-dm' })
const team = memberDirectory({ members: [general, analyst], general_id: 'g' }, 'ready')
const research = [{ id: 'r1', title: 'Pruning' }] as unknown as ResearchSummary[]
const turn = (id: string, user: string, assistant: string): DmTurn => ({ run_id: id, user, assistant })

type Context = { memory?: PlaceMemory; navigation?: WorkspaceNavigation; directory?: MemberDirectory }

function context(children: ReactNode, { directory = team, memory, navigation }: Context = {}) {
  const inner = (
    <MemberDirectoryContext.Provider value={directory}>
      {navigation ? <WorkspaceNavigationContext.Provider value={navigation}>{children}</WorkspaceNavigationContext.Provider> : children}
    </MemberDirectoryContext.Provider>
  )
  return memory ? <PlaceMemoryProvider memory={memory}>{inner}</PlaceMemoryProvider> : inner
}

function fakeApi(overrides: Partial<Record<keyof KubecodeApi, unknown>> = {}) {
  return {
    memberDmTurns: vi.fn().mockResolvedValue([
      turn('run-1', 'is 0.91 enough?', 'It is **within** a point.'),
      turn('run-2', 'what about the reviewer?', 'Mention it to them.'),
    ]),
    sendMemberDm: vi.fn().mockResolvedValue(undefined),
    previewDmShare: vi.fn().mockResolvedValue({ text: '> is 0.91 enough?\n\nIt is **within** a point.', digest: 'd1', task_id: 'r1' }),
    shareDm: vi.fn().mockResolvedValue(channelMessage(7, { id: 'shared-1' })),
    postChannelMessage: vi.fn(),
    ...overrides,
  }
}

function pane(api: ReturnType<typeof fakeApi>, extra: Partial<React.ComponentProps<typeof DmPane>> = {}, events: WorkspaceEvent[] = []) {
  return (
    <DmPane
      api={api as unknown as KubecodeApi}
      connectionState="live"
      events={events}
      member={analyst}
      projectId="p1"
      research={research}
      t={t}
      {...extra}
    />
  )
}

function setup(overrides: Partial<Record<keyof KubecodeApi, unknown>> = {}, options: Context & { member?: Member } = {}) {
  const api = fakeApi(overrides)
  const onShared = vi.fn()
  const view = render(context(pane(api, { onShared, member: options.member ?? analyst }), options))
  return { api, onShared, view }
}

const box = () => screen.getByRole('textbox', { name: 'Message Analyst privately' }) as HTMLTextAreaElement

async function openShare() {
  fireEvent.click(screen.getByRole('button', { name: 'Share to General…' }))
  return screen.findByRole('dialog')
}

describe('DmPane', () => {
  it('shows who the conversation is with, that it is private, and both sides in Markdown', async () => {
    setup()
    expect(await screen.findByText('is 0.91 enough?')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Analyst/ })).toBeInTheDocument()
    expect(screen.getByText('Private')).toBeInTheDocument()
    expect(screen.queryByText(/Only you and Analyst see this/)).not.toBeInTheDocument()
    expect(screen.getByText('within').tagName).toBe('STRONG')
    const log = screen.getByRole('log')
    // The researcher's own turns sit on the right with no visible "You", but keep an accessible author.
    expect(within(log).queryByText('You', { selector: ':not(.sr-only)' })).not.toBeInTheDocument()
    expect(within(log).getAllByRole('article', { name: 'You' })).toHaveLength(2)
    expect(within(log).getAllByText('Specialist · Analysis').length).toBeGreaterThan(0)
    expect(screen.queryByText('Only Analyst sees this message.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mention someone' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add context' })).not.toBeInTheDocument()
  })

  it('reads as a conversation: each side its own message, the researcher\'s tinted, in one prompt card', async () => {
    setup({ memberDmTurns: vi.fn().mockResolvedValue([turn('run-1', 'is 0.91 enough?', 'It is **within** a point.'), turn('run-2', 'and now?', '')]) })
    const question = await screen.findByText('is 0.91 enough?')
    expect(question.closest('article')).toHaveAttribute('data-from', 'self')
    expect(screen.getByText('within').closest('article')).toHaveAttribute('data-from', 'member')
    const waiting = screen.getByText("Waiting for Analyst's reply")
    expect(waiting.closest('article')).toHaveAttribute('data-state', 'pending')
    const card = box().closest('form') as HTMLElement
    expect(card).toContainElement(box())
    expect(card).not.toHaveTextContent('Only Analyst sees this message.')
    // Empty, the card is compact: two lines that grow with the text.
    expect(box()).toHaveAttribute('rows', '2')
  })

  it('sends privately and never into General, and waits visibly for the reply', async () => {
    const { api } = setup({ memberDmTurns: vi.fn().mockResolvedValue([turn('run-1', 'thinking out loud', '')]) })
    expect(await screen.findByText("Waiting for Analyst's reply")).toBeInTheDocument()
    fireEvent.change(box(), { target: { value: 'my private plan' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(api.sendMemberDm).toHaveBeenCalledWith('p1', 'm1', 'my private plan', expect.any(String)))
    await waitFor(() => expect(box()).toHaveValue(''))
    expect(api.postChannelMessage).not.toHaveBeenCalled()
  })

  it('names a dropped connection in the interface language, never the browser\'s raw fetch error', async () => {
    setup({ sendMemberDm: vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')) })
    await screen.findByText('is 0.91 enough?')
    fireEvent.change(box(), { target: { value: 'hello' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(await screen.findByRole('alert')).toHaveTextContent('Not sent: Something went wrong')
  })

  it('keeps a failed send as its own row, sends it again under one id, never touches what is typed since, and new words get a new id', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new ApiError('dm_failed', 'x', 502))
      .mockRejectedValueOnce(new ApiError('dm_busy', 'x', 409))
      .mockResolvedValue(undefined)
    setup({ sendMemberDm: send })
    await screen.findByText('is 0.91 enough?')
    fireEvent.change(box(), { target: { value: 'hello' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(await screen.findByRole('alert')).toHaveTextContent('Not sent: The message could not be delivered')
    expect(screen.getByRole('list', { name: 'Unsent messages' })).toHaveTextContent('hello')
    expect(box()).toHaveValue('')
    fireEvent.change(box(), { target: { value: 'typed meanwhile' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send again' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      'Not sent: Analyst is still answering your last message. Your message is kept; try again in a moment.',
    ))
    fireEvent.click(screen.getByRole('button', { name: 'Send again' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(3))
    // One message, however often it is sent again: the server admits it once.
    expect(send.mock.calls[1][3]).toBe(send.mock.calls[0][3])
    expect(send.mock.calls[2][3]).toBe(send.mock.calls[0][3])
    expect(send.mock.calls[2][2]).toBe('hello')
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Unsent messages' })).not.toBeInTheDocument())
    expect(box()).toHaveValue('typed meanwhile')
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(send).toHaveBeenCalledTimes(4))
    expect(send.mock.calls[3][3]).not.toBe(send.mock.calls[0][3])
  })

  it('cannot be written to while the member needs setup, and says where to fix it', async () => {
    const navigation = fakeNavigation()
    setup({}, { navigation, member: { ...analyst, state: 'setup_required' } })
    await screen.findByText('is 0.91 enough?')
    expect(box()).toBeDisabled()
    expect(screen.getByText('Analyst needs setup before you can message them.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Fix in Members' }))
    expect(navigation.openPlace).toHaveBeenCalledWith({ view: 'members' }, { inspect: { kind: 'member', id: 'm1' } })
  })

  it('refreshes from the DM Session events only, and offers a retry when the turns cannot load', async () => {
    const turns = vi.fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue([turn('run-1', 'is 0.91 enough?', 'ok')])
    const api = fakeApi({ memberDmTurns: turns })
    const view = render(context(pane(api)))
    const failure = await screen.findByRole('alert')
    expect(failure).toHaveTextContent('The conversation could not be loaded.')
    // The official Alert, its Retry inside it (#257).
    expect(failure).toHaveAttribute('data-slot', 'alert')
    expect(within(failure).getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('is 0.91 enough?')).toBeInTheDocument()
    const before = turns.mock.calls.length
    const event = (id: number, conversation: string): WorkspaceEvent => ({
      id, kind: 'agent_event', project_id: 'p1', conversation_id: conversation, run_id: null, payload: {}, created_at: '',
    })
    view.rerender(context(pane(api, {}, [event(1, 's-public')])))
    expect(turns.mock.calls.length).toBe(before)
    view.rerender(context(pane(api, {}, [event(1, 's-public'), event(2, 's-dm')])))
    await waitFor(() => expect(turns.mock.calls.length).toBe(before + 1))
  })
})

describe('DmPane while the member is at work (ADR 0232)', () => {
  it('shows a message queued behind the running reply as pending, also after a reload', async () => {
    const pending = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ client_message_id: 'k1', text: 'and the ablation?', position: 1, created_at: '' }])
    const { api, view } = setup({
      sendMemberDm: vi.fn().mockResolvedValue({ state: 'delivered', admission: 'queued' }),
      memberDmPending: pending,
    })
    await screen.findByText('is 0.91 enough?')
    fireEvent.change(box(), { target: { value: 'and the ablation?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(api.sendMemberDm).toHaveBeenCalled())
    const queued = await screen.findByText('Analyst will read this after the current reply')
    expect(queued.closest('article')).toHaveTextContent('and the ablation?')
    // A reload reads the queue from the server.
    view.unmount()
    render(context(pane(api)))
    expect(await screen.findByText('Analyst will read this after the current reply')).toBeInTheDocument()
  })

  it('offers a Stop that names the member\'s reply while the member answers', async () => {
    const store = {
      projectId: 'p1',
      snapshot: null,
      status: 'ready' as const,
      forTask: () => [],
      byKey: () => undefined,
      executions: (scope: { binding?: string }) => (scope.binding === 'dm' ? [execution({ binding: 'dm', conversation_id: 's-dm', tasks: [] })] : []),
      failures: () => [],
      resolving: new Set<string>(),
      markResolving: vi.fn(),
      reload: vi.fn(),
    }
    const api = fakeApi({ cancelRun: vi.fn().mockResolvedValue(undefined) })
    render(context(<AttentionContext.Provider value={store as never}>{pane(api)}</AttentionContext.Provider>))
    await screen.findByText('is 0.91 enough?')
    // One Stop per reply: the strip's, never a second beside Send.
    const stops = screen.getAllByRole('button', { name: /^Stop/ })
    expect(stops).toHaveLength(1)
    expect(stops[0]).toHaveAccessibleName("Stop Analyst's reply")
    fireEvent.click(stops[0])
    await waitFor(() => expect(api.cancelRun).toHaveBeenCalledWith('run1'))
  })
})

describe('DmPane sharing to General (ADR 0223 §5, ADR 0229 §6)', () => {
  it('previews the exact text as General will show it, with its recipient and Task, then posts and shows it in General', async () => {
    const navigation = fakeNavigation()
    const { api, onShared } = setup({}, { navigation })
    await screen.findByText('is 0.91 enough?')
    const dialog = await openShare()
    expect(within(dialog).getByRole('button', { name: 'Preview' })).toBeDisabled()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /is 0.91 enough/ }))
    expect(within(dialog).getByText('1 of 6 chosen')).toBeInTheDocument()
    // The official Field, Checkbox and Select (#257).
    expect(within(dialog).getByRole('group', { name: 'Turns to share' })).toBeInTheDocument()
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Add a note (optional)' }), { target: { value: 'for everyone' } })
    fireEvent.keyDown(within(dialog).getByRole('combobox', { name: 'About Task' }), { key: 'ArrowDown' })
    fireEvent.keyDown(await screen.findByRole('option', { name: 'Pruning' }), { key: 'Enter' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview' }))
    const card = await within(dialog).findByRole('region', { name: 'Preview' })
    expect(api.previewDmShare).toHaveBeenCalledWith('p1', 'm1', { runIds: ['run-1'], note: 'for everyone', taskId: 'r1' })
    expect(within(card).getByText('You')).toBeInTheDocument()
    expect(within(card).getByText('To')).toBeInTheDocument()
    expect(within(card).getByText('General')).toBeInTheDocument()
    expect(within(card).getByText('Pruning')).toBeInTheDocument()
    expect(within(card).getByText('within').tagName).toBe('STRONG')
    expect(within(card).getByText('This will reach General, the project manager, like anything you write in General.')).toBeInTheDocument()
    expect(within(card).getByText('Exact text')).toBeInTheDocument()
    // The body is the official Message bubble General uses; the exact text is the official Code Block (#278).
    expect(within(card).getByTestId('conversation-response').closest('.is-user')).not.toBeNull()
    expect(card.querySelector('.kubecode-message-body, .ai-markdown')).toBeNull()
    expect(card.querySelector('[data-language="text"]')).toHaveTextContent('> is 0.91 enough?')
    // Editing makes the preview stale: it must be shown again.
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Add a note (optional)' }), { target: { value: 'for everyone!' } })
    expect(within(dialog).queryByRole('region', { name: 'Preview' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Post to General' })).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview' }))
    await within(dialog).findByRole('region', { name: 'Preview' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post to General' }))
    await waitFor(() => expect(api.shareDm).toHaveBeenCalledWith('p1', 'm1', {
      runIds: ['run-1'], note: 'for everyone!', taskId: 'r1', digest: 'd1', clientMessageId: expect.any(String),
    }))
    await waitFor(() => expect(onShared).toHaveBeenCalled())
    expect(await screen.findByText('Shared to General.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show in General' }))
    expect(navigation.openPlace).toHaveBeenCalledWith({ view: 'general', message: 'shared-1' }, { focus: 'message:shared-1' })
    expect(api.postChannelMessage).not.toHaveBeenCalled()
  })

  it('says in the preview when the project manager cannot receive the share, and never names General as the recipient', async () => {
    const unreadyManager = { ...general, state: 'setup_required' as const, public_conversation_id: null }
    for (const directory of [
      memberDirectory({ members: [unreadyManager, analyst], general_id: 'g' }, 'ready'),
      memberDirectory({ members: [analyst], general_id: null }, 'ready'),
    ]) {
      const { view } = setup({}, { directory })
      await screen.findByText('is 0.91 enough?')
      const dialog = await openShare()
      fireEvent.click(within(dialog).getByRole('checkbox', { name: /is 0.91 enough/ }))
      fireEvent.click(within(dialog).getByRole('button', { name: 'Preview' }))
      const card = await within(dialog).findByRole('region', { name: 'Preview' })
      // The official Card's own surface, with no legacy redraw class (#257).
      expect(card).toHaveAttribute('data-slot', 'card')
      expect(card.className).not.toMatch(/kubecode-/)
      expect(within(card).getByRole('status')).toHaveTextContent('No one can receive this yet: the project manager needs setup.')
      expect(card).not.toHaveTextContent('This will reach')
      expect(within(card).queryByText('General · Project manager')).not.toBeInTheDocument()
      if (directory.manager) expect(card).toHaveTextContent(/General.*Needs setup/)
      view.unmount()
    }
  })

  it('drops the preview when the server says the conversation changed, and bounds the turns', async () => {
    const many = Array.from({ length: 8 }, (_, index) => turn(`run-${index}`, `question ${index}`, 'a'))
    const share = vi.fn().mockRejectedValue(new ApiError('dm_share_stale', 'x', 409))
    const { api } = setup({ memberDmTurns: vi.fn().mockResolvedValue(many), shareDm: share })
    await screen.findByText('question 0')
    const dialog = await openShare()
    for (let index = 0; index < 8; index += 1) {
      fireEvent.click(within(dialog).getByRole('checkbox', { name: new RegExp(`question ${index}$`) }))
    }
    expect(within(dialog).getAllByRole('checkbox').filter((item) => item.getAttribute('aria-checked') === 'true')).toHaveLength(6)
    expect(within(dialog).getByText('6 of 6 chosen')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview' }))
    await within(dialog).findByRole('region', { name: 'Preview' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post to General' }))
    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent('Preview it again')
    expect(alert).toHaveAttribute('data-slot', 'alert')
    expect(within(dialog).queryByRole('region', { name: 'Preview' })).not.toBeInTheDocument()
    expect(api.previewDmShare).toHaveBeenCalledTimes(1)
  })

  it('forgets the selection when closed, and a second share is a new message', async () => {
    const share = vi.fn().mockResolvedValue(channelMessage(8))
    const { api } = setup({ shareDm: share })
    await screen.findByText('is 0.91 enough?')
    let dialog = await openShare()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /is 0.91 enough/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview' }))
    await within(dialog).findByRole('region', { name: 'Preview' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    dialog = await openShare()
    expect(within(dialog).queryByRole('region', { name: 'Preview' })).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Preview' })).toBeDisabled()
    for (let round = 0; round < 2; round += 1) {
      fireEvent.click(within(dialog).getByRole('checkbox', { name: /is 0.91 enough/ }))
      fireEvent.click(within(dialog).getByRole('button', { name: 'Preview' }))
      await within(dialog).findByRole('region', { name: 'Preview' })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Post to General' }))
      await waitFor(() => expect(share).toHaveBeenCalledTimes(round + 1))
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      if (round === 0) dialog = await openShare()
    }
    expect(share.mock.calls[0][2].clientMessageId).not.toBe(share.mock.calls[1][2].clientMessageId)
    expect(api.previewDmShare).toHaveBeenCalledTimes(3)
  })
})

describe('DmPane sharing names General in each language', () => {
  it('names General the way the language names the conversation, never in English', () => {
    for (const locale of APP_LOCALES) {
      const translate = createTranslator(locale)
      const general = translate('kubecode.channel.general')
      for (const key of ['kubecode.dm.share', 'kubecode.dm.shared', 'kubecode.dm.shareConfirm'] as const) {
        expect(translate(key), `${locale} ${key}`).toContain(general)
      }
    }
  })
})

describe('DmPane drafts kept for the place (ADR 0228 §4, ADR 0229 §6)', () => {
  function GeneralComposer() {
    const [draft, setDraft] = usePlaceState<GeneralDraft>(`${placeKey.general('p1')}#draft`, emptyGeneralDraft(null))
    return (
      <MessageComposer
        api={{} as KubecodeApi}
        directory={team}
        draft={draft}
        focusKey="composer:general"
        labels={localReferenceLabels({ research: [], threads: [], sessions: [], picked: [], t })}
        placeholder="Message the Workspace"
        projectId="p1"
        outboxKey={`${placeKey.general('p1')}#outbox`}
        t={t}
        onDraftChange={setDraft}
        onSend={vi.fn()}
      />
    )
  }

  it('keeps the private draft and an unsent message per member, and never shows them in General', async () => {
    const memory = createPlaceMemory()
    const send = vi.fn().mockRejectedValueOnce(new ApiError('dm_failed', 'x', 502)).mockResolvedValue(undefined)
    const api = fakeApi({ memberDmTurns: vi.fn().mockResolvedValue([]), sendMemberDm: send })
    const view = render(context(pane(api), { memory }))
    expect(box()).toHaveAttribute('data-focus-key', 'composer:dm:m1')
    fireEvent.change(box(), { target: { value: 'just between us' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be delivered')
    fireEvent.change(box(), { target: { value: 'half typed' } })

    view.rerender(context(<GeneralComposer />, { memory }))
    expect(screen.getByRole('combobox', { name: 'Message the Workspace' })).toHaveValue('')
    expect(document.body).not.toHaveTextContent('just between us')

    view.rerender(context(pane(api, { member: { ...analyst, id: 'm2' } }), { memory }))
    expect(box()).toHaveValue('')
    expect(screen.queryByRole('list', { name: 'Unsent messages' })).not.toBeInTheDocument()

    view.rerender(context(pane(api), { memory }))
    expect(box()).toHaveValue('half typed')
    fireEvent.click(screen.getByRole('button', { name: 'Send again' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    expect(send.mock.calls[1][3]).toBe(send.mock.calls[0][3])
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Unsent messages' })).not.toBeInTheDocument())
    expect(box()).toHaveValue('half typed')
  })
})
