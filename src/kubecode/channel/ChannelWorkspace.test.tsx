import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import type {
  ChannelMessage,
  ChannelThread,
  Conversation,
  ExecutionView,
  KubecodeApi,
  NewChannelMessage,
  ResearchSummary,
  WorkspaceEvent,
} from '../api'
import { ApiError } from '../api'
import { fakeNavigation } from '../app/inspector/inspectorTesting'
import { createPlaceMemory, type PlaceMemory } from '../app/location/placeMemory'
import { PlaceMemoryProvider } from '../app/location/PlaceMemoryProvider'
import { WorkspaceNavigationContext, type WorkspaceNavigation } from '../app/location/WorkspaceNavigation'
import { memberDirectory, MemberDirectoryContext, type MemberDirectory } from '../members/memberDirectory'
import { analyst, channelMessage, general, writer } from '../members/memberFixtures'
import { AttentionContext, type AttentionStore } from '../attention/attentionContext'
import { execution, messageDelivery, routeDelivery, snapshot } from '../attention/attentionFixtures'
import { ChannelWorkspace } from './ChannelWorkspace'

const t = createTranslator('en')

const channel = {
  id: 'c1', project_id: 'p1', name: 'general', is_default: true, last_seq: 0, created_at: '2026-10-18 10:00:00',
}

const question: ResearchSummary = {
  id: 'r1', project_id: 'p1', title: 'Pruning', status: 'open', archived: false,
  revision: 1, entry_count: 0, link_count: 0, updated_at: '',
}

const team = memberDirectory({ members: [general, analyst, writer], general_id: 'g' }, 'ready')

/** A tiny in-memory conversation server with the real API's replay and revision rules. */
function server(initial: ChannelMessage[] = []) {
  const messages = [...initial]
  const threads: ChannelThread[] = []
  const posted: NewChannelMessage[] = []
  let failNext = 0
  const message = (seq: number, body: string, extra: Partial<ChannelMessage> = {}) => channelMessage(seq, { body, ...extra })
  const inScope = (threadId: string | null | undefined) => (candidate: ChannelMessage) => {
    if (!threadId) return candidate.thread_id === null
    const thread = threads.find((item) => item.id === threadId)
    return candidate.thread_id === threadId || candidate.id === thread?.root_message_id
  }
  const thread = (root: string, extra: Partial<ChannelThread> = {}): ChannelThread => {
    const created: ChannelThread = {
      id: `t${threads.length + 1}`, project_id: 'p1', channel_id: 'c1', root_message_id: root,
      title: messages.find((m) => m.id === root)?.body ?? root, research_id: null, round_id: null, revision: 1,
      reply_count: 0, last_seq: 0, created_by: 'researcher', created_at: '', updated_at: '', ...extra,
    }
    threads.push(created)
    return created
  }
  const api = {
    listChannels: vi.fn(async () => [channel]),
    listChannelMessages: vi.fn(async (
      _p: string,
      _c: string,
      options: { threadId?: string | null; taskId?: string | null; beforeSeq?: number; afterSeq?: number; limit?: number } = {},
    ) => {
      const limit = options.limit ?? 50
      const scoped = messages
        .filter(inScope(options.threadId))
        .filter((candidate) => !options.taskId || candidate.task_id === options.taskId)
      if (options.afterSeq !== undefined) {
        const page = scoped.filter((m) => m.seq > options.afterSeq!).slice(0, limit)
        return { messages: page, has_more: false }
      }
      const before = scoped.filter((m) => m.seq < (options.beforeSeq ?? Infinity))
      const page = before.slice(-limit)
      return { messages: page, has_more: before.length > page.length }
    }),
    getChannelMessage: vi.fn(async (_p: string, _c: string, id: string) => messages.find((m) => m.id === id)!),
    postChannelMessage: vi.fn(async (_p: string, _c: string, input: NewChannelMessage) => {
      posted.push(input)
      if (failNext > 0) {
        failNext -= 1
        throw new Error('network down')
      }
      const existing = messages.find((m) => input.clientMessageId && m.client_message_id === input.clientMessageId)
      if (existing) return existing
      const research = input.references?.find((ref) => ref.kind === 'research')
      const created = message(messages.length + 1, input.body, {
        client_message_id: input.clientMessageId ?? null,
        mentions: (input.mentions ?? []).map((mention) => ({ session_id: `s-${mention.member_id}` })),
        mention_member_ids: (input.mentions ?? []).map((mention) => mention.member_id),
        references: input.references ?? [],
        reply_to: input.replyTo ?? null,
        task_id: research?.id ?? null,
      })
      messages.push(created)
      return created
    }),
    listChannelThreads: vi.fn(async () => [...threads]),
    // What a reply must never do: start a Thread, write privately, or admit or start a Task.
    startChannelThread: vi.fn(async () => thread('never')),
    openMemberDm: vi.fn(),
    sendMemberDm: vi.fn(),
    shareDm: vi.fn(),
    createResearch: vi.fn(),
    reviewTask: vi.fn(),
    reviewResearchProposal: vi.fn(),
    startResearchRound: vi.fn(),
    createConversation: vi.fn(),
    startStructuredRun: vi.fn(),
    listResearchRounds: vi.fn(async () => [{ id: 'round-1', research_id: 'r1', round: 1 }]),
    linkChannelThread: vi.fn(async (
      _p: string, id: string, revision: number, researchId: string | null, roundId: string | null = null,
    ) => {
      const found = threads.find((item) => item.id === id)!
      if (found.revision !== revision) {
        throw new ApiError('thread_revision_conflict', 'changed', 409)
      }
      found.research_id = researchId
      found.round_id = roundId
      found.revision += 1
      return found
    }),
  }
  return {
    api: api as unknown as KubecodeApi,
    calls: api,
    messages,
    posted,
    threads,
    thread,
    message,
    failNext: (count: number) => { failNext = count },
  }
}

type Props = Partial<React.ComponentProps<typeof ChannelWorkspace>>

function shell(children: ReactNode, {
  directory = team,
  memory,
  navigation,
}: { directory?: MemberDirectory; memory?: PlaceMemory; navigation?: WorkspaceNavigation } = {}) {
  const inner = <MemberDirectoryContext.Provider value={directory}>{children}</MemberDirectoryContext.Provider>
  const routed = navigation
    ? <WorkspaceNavigationContext.Provider value={navigation}>{inner}</WorkspaceNavigationContext.Provider>
    : inner
  return memory ? <PlaceMemoryProvider memory={memory}>{routed}</PlaceMemoryProvider> : routed
}

function workspace(s: ReturnType<typeof server>, props: Props = {}, events: WorkspaceEvent[] = []) {
  return (
    <ChannelWorkspace
      api={s.api}
      connectionState="live"
      conversations={[]}
      events={events}
      projectId="p1"
      research={[question]}
      t={t}
      {...props}
    />
  )
}

function view(
  s: ReturnType<typeof server>,
  { directory, memory, navigation, props = {} }: {
    directory?: MemberDirectory; memory?: PlaceMemory; navigation?: WorkspaceNavigation; props?: Props
  } = {},
) {
  const context = { directory, memory, navigation }
  const result = render(shell(workspace(s, props), context))
  return {
    ...result,
    rerenderWith: (next: Props, events: WorkspaceEvent[] = []) => result.rerender(shell(workspace(s, { ...props, ...next }, events), context)),
  }
}

const channelEvent = (id: number): WorkspaceEvent => ({
  id, kind: 'channel_updated', project_id: 'p1', conversation_id: null, run_id: null,
  payload: { channel_id: 'c1', thread_id: null, change: 'message' }, created_at: '',
})

const box = () => screen.getByRole('combobox', { name: 'Message the Workspace' }) as HTMLTextAreaElement
const send = () => fireEvent.click(screen.getByRole('button', { name: 'Send' }))
const toRow = () => document.querySelector('.kubecode-composer-to')
const row = (seq: number) => screen.getByTestId(`message-${seq}`)

describe('ChannelWorkspace', () => {
  it('is General with no description line, posts a message, and keeps one client id across a failed send', async () => {
    const s = server()
    view(s)
    const empty = await screen.findByText('No messages yet. Start the discussion.')
    // An empty General is the AI Elements empty state of the #230 prototypes, not a stray line.
    expect(empty.closest('.kubecode-ai-conversation-empty')).not.toBeNull()
    expect(screen.getByRole('heading', { name: 'General' })).toBeInTheDocument()
    expect(screen.queryByText(/Messages go to the project manager unless you @mention someone/)).not.toBeInTheDocument()
    fireEvent.change(box(), { target: { value: '  Should we prune?  ' } })
    s.failNext(1)
    send()
    expect(await screen.findByRole('alert')).toHaveTextContent('Not sent: network down')
    expect(box()).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: 'Send again' }))
    expect(await screen.findByText('Should we prune?', { selector: '[data-message-id] *' })).toBeInTheDocument()
    expect(s.posted).toHaveLength(2)
    expect(s.posted[1].clientMessageId).toBe(s.posted[0].clientMessageId)
    expect(s.posted[1].body).toBe('Should we prune?')
    expect(box()).toHaveValue('')
    fireEvent.change(box(), { target: { value: 'Another' } })
    send()
    await screen.findByText('Another')
    expect(s.posted[2].clientMessageId).not.toBe(s.posted[0].clientMessageId)
    expect(s.messages).toHaveLength(2)
  })

  it('converges on channel events and on a reconnect without repeating messages', async () => {
    const s = server([])
    const v = view(s)
    await screen.findByText('No messages yet. Start the discussion.')
    s.messages.push(s.message(1, 'from elsewhere'))
    await act(async () => v.rerenderWith({}, [channelEvent(5)]))
    expect(await screen.findByText('from elsewhere')).toBeInTheDocument()
    s.messages.push(s.message(2, 'second'))
    await act(async () => v.rerenderWith({}, [channelEvent(5), channelEvent(6)]))
    expect(await screen.findByText('second')).toBeInTheDocument()
    expect(screen.getAllByText('from elsewhere')).toHaveLength(1)
  })

  it('shows the latest page and loads earlier messages on request', async () => {
    const s = server(Array.from({ length: 60 }, (_, index) => server().message(index + 1, `message ${index + 1}`)))
    view(s)
    expect(await screen.findByText('message 60')).toBeInTheDocument()
    expect(screen.queryByText('message 10')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }))
    expect(await screen.findByText('message 10')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load earlier messages' })).not.toBeInTheDocument()
  })

  it('sends every message as a plain message with visible recipients and member-id mentions', async () => {
    const s = server()
    view(s)
    await screen.findByText('No messages yet. Start the discussion.')
    expect(screen.queryByRole('combobox', { name: 'Message type' })).not.toBeInTheDocument()
    expect(toRow()).toBeNull()
    fireEvent.change(box(), { target: { value: '@analyst run the sweep', selectionStart: 22 } })
    expect(toRow()).toBeNull()
    send()
    await screen.findByText('run the sweep', { exact: false })
    expect(s.posted[0]).toEqual({
      body: '@analyst run the sweep', clientMessageId: expect.any(String), mentions: [{ member_id: 'a' }], references: [], replyTo: null,
    })
    // The sent message says whom it went to, by name.
    expect(within(row(1)).getByText('To')).toBeInTheDocument()
    expect(within(row(1)).getByText('Analyst')).toBeInTheDocument()
  })

  it('offers every live member to @mention by member id, and says who cannot receive yet', async () => {
    const unready = { ...writer, state: 'setup_required' as const, public_conversation_id: null }
    const s = server()
    view(s, { directory: memberDirectory({ members: [general, analyst, unready], general_id: 'g' }, 'ready') })
    await screen.findByText('No messages yet. Start the discussion.')
    fireEvent.change(box(), { target: { value: '@', selectionStart: 1 } })
    const options = within(await screen.findByRole('listbox')).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('@general'), expect.stringContaining('@analyst'), expect.stringContaining("Can't receive messages yet"),
    ])
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(box()).toHaveValue('@analyst ')
  })

  it('reports a failed load and tolerates a host without a conversation', async () => {
    const s = server()
    s.calls.listChannelMessages.mockRejectedValue(new Error('down'))
    view(s)
    await waitFor(() => expect(screen.getAllByText(/The conversation could not be loaded/).length).toBeGreaterThan(0))
    const bare = { ...s.api, listChannels: undefined, listChannelMessages: undefined } as unknown as KubecodeApi
    render(shell(<ChannelWorkspace api={bare} connectionState="live" conversations={[]} events={[]} projectId="p1" research={[]} t={t} />))
  })
})

describe('ChannelWorkspace identity (ADR 0229 §1)', () => {
  it('keeps General and two specialists apart after a Session replacement, and never says "Agent"', async () => {
    const replaced = memberDirectory({ members: [general, { ...analyst, public_conversation_id: 's-a2' }, writer], general_id: 'g' }, 'ready')
    const s = server([
      server().message(1, 'plan', { author_kind: 'agent', author_ref: 's-g', author_member_id: 'g' }),
      server().message(2, 'old analysis', { author_kind: 'agent', author_ref: 's-a', author_member_id: 'a' }),
      server().message(3, 'new analysis', { author_kind: 'agent', author_ref: 's-a2', author_member_id: 'a' }),
      server().message(4, 'draft', { author_kind: 'agent', author_ref: 's-w', author_member_id: 'w' }),
    ])
    view(s, { directory: replaced })
    await screen.findByText('draft')
    expect(row(1)).toHaveAttribute('aria-label', 'General')
    expect(row(2)).toHaveAttribute('aria-label', 'Analyst')
    expect(row(3)).toHaveAttribute('aria-label', 'Analyst')
    expect(row(4)).toHaveAttribute('aria-label', 'Writer')
    expect(screen.getByRole('log')).not.toHaveTextContent(/\bAgent\b/)
  })

  it('names authors and recipients through the current Sessions when the server could not say', async () => {
    const s = server([
      server().message(1, 'over to you', { author_kind: 'agent', author_ref: 's-g', mentions: [{ session_id: 's-w' }] }),
    ])
    view(s)
    await screen.findByText('over to you')
    expect(row(1)).toHaveAttribute('aria-label', 'General')
    expect(within(row(1)).getByText('Handed to')).toBeInTheDocument()
    expect(within(row(1)).getByText('Writer')).toBeInTheDocument()
  })

  it('opens a member’s profile from their name and comes back to the message', async () => {
    const navigation = fakeNavigation()
    const s = server([server().message(1, 'done', { author_kind: 'agent', author_ref: 's-a', author_member_id: 'a' })])
    view(s, { navigation })
    fireEvent.click(await screen.findByRole('button', { name: 'Analyst' }))
    expect(navigation.inspect).toHaveBeenCalledWith({ kind: 'member', id: 'a' }, { from: 'message:m1' })
  })
})

describe('ChannelWorkspace replies (ADR 0229 §4)', () => {
  it('replies in General: cites the message, names a specialist, and never starts a Thread or a Task', async () => {
    const s = server([
      server().message(1, 'Sweep finished; accuracy held.', { author_kind: 'agent', author_ref: 's-a', author_member_id: 'a', task_id: 'r1' }),
    ])
    view(s)
    await screen.findByText('Sweep finished; accuracy held.')
    fireEvent.click(screen.getByRole('button', { name: 'Reply to Analyst' }))
    expect(box()).toHaveValue('@analyst ')
    await waitFor(() => expect(box()).toHaveFocus())
    expect(box().selectionStart).toBe(9)
    expect(screen.getByText('Replying to Analyst: Sweep finished; accuracy held.')).toBeInTheDocument()
    expect(screen.getAllByText('Replying to Analyst').some((element) => element.getAttribute('role') === 'status')).toBe(true)
    expect(toRow()).toBeNull()
    // The cited message's Task comes along, visibly.
    expect(within(document.querySelector('.kubecode-composer-about') as HTMLElement).getByText('Pruning')).toBeInTheDocument()
    // Taking the mention out of the text sends the reply to the manager instead; the citation stays.
    fireEvent.change(box(), { target: { value: '' } })
    fireEvent.change(box(), { target: { value: 'yes, add it' } })
    send()
    await screen.findByText('yes, add it')
    expect(s.posted[0]).toMatchObject({ replyTo: 'm1', mentions: [], references: [{ kind: 'research', id: 'r1', revision: null }] })
    // Nothing but the one plain message was written: no Thread, no private message, no Task admitted or started.
    expect(s.calls.postChannelMessage).toHaveBeenCalledTimes(1)
    expect(s.posted[0]).not.toHaveProperty('threadId')
    expect(s.posted[0]).not.toHaveProperty('intent')
    expect(s.threads).toHaveLength(0)
    for (const spy of [
      s.calls.startChannelThread, s.calls.openMemberDm, s.calls.sendMemberDm, s.calls.shareDm,
      s.calls.createResearch, s.calls.reviewTask, s.calls.reviewResearchProposal, s.calls.startResearchRound,
      s.calls.createConversation, s.calls.startStructuredRun,
    ]) expect(spy).not.toHaveBeenCalled()
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText(/Replying to Analyst:/)).not.toBeInTheDocument())
  })

  it('replying to the manager adds no mention, so the reply still reaches the manager', async () => {
    const s = server([server().message(1, 'Shall I add it?', { author_kind: 'agent', author_ref: 's-g', author_member_id: 'g' })])
    view(s)
    fireEvent.click(await screen.findByRole('button', { name: 'Reply to General' }))
    expect(box()).toHaveValue('')
    expect(toRow()).toBeNull()
  })

  it('jumps to a cited message, loads it when it is not loaded, and keeps routing notes collapsed', async () => {
    const many = Array.from({ length: 60 }, (_, index) => server().message(index + 1, `message ${index + 1}`))
    const s = server([
      ...many,
      server().message(61, 'noted', { reply_to: 'm60' }),
      server().message(62, 'routed to the manager', { author_kind: 'system', kind: 'system' }),
      server().message(63, 'routed again', { author_kind: 'system', kind: 'system' }),
      server().message(64, 'Review outcome: accepted', { author_kind: 'system', kind: 'system', task_id: 'r1' }),
      server().message(65, 'about the start', { reply_to: 'm2' }),
    ])
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    view(s)
    await screen.findByText('about the start')
    // Routine notes are one quiet, expandable line; a decision about a Task is shown.
    const activity = screen.getByText('Activity (2)').closest('details')
    expect(activity).not.toHaveAttribute('open')
    expect(screen.getByTestId('message-64').tagName).toBe('ARTICLE')
    fireEvent.click(within(row(61)).getByRole('button', { name: /In reply to You: message 60/ }))
    expect(scroll).toHaveBeenCalled()
    expect(document.getElementById('message-m60')).toHaveFocus()
    // The cited message is not loaded: it is loaded around, and landed on.
    expect(screen.queryByText('message 2')).not.toBeInTheDocument()
    fireEvent.click(within(row(65)).getByRole('button', { name: 'In reply to an earlier message' }))
    await waitFor(() => expect(s.calls.getChannelMessage).toHaveBeenCalledWith('p1', 'c1', 'm2'))
    await waitFor(() => expect(document.getElementById('message-m2')).toHaveFocus())
  })
})

describe('ChannelWorkspace Tasks and references', () => {
  it('shows only what is about one Task as a view of the same messages', async () => {
    const s = server([
      server().message(1, 'about pruning', { task_id: 'r1' }),
      server().message(2, 'general chatter'),
    ])
    const onFilterChange = vi.fn()
    view(s, { props: { onFilterChange } })
    await screen.findByText('about pruning')
    fireEvent.change(screen.getByLabelText('Show messages about'), { target: { value: 'r1' } })
    await waitFor(() => expect(screen.queryByText('general chatter')).not.toBeInTheDocument())
    expect(onFilterChange).toHaveBeenLastCalledWith('r1')
    expect(s.calls.listChannelMessages).toHaveBeenLastCalledWith('p1', 'c1', expect.objectContaining({ taskId: 'r1' }))
    // The filter is a removable chip too.
    fireEvent.click(screen.getByRole('button', { name: 'Show everything' }))
    expect(await screen.findByText('general chatter')).toBeInTheDocument()
    // Without a Task pane, a message's Task chip narrows to that Task.
    fireEvent.click(within(row(1)).getByRole('button', { name: 'Task Pruning' }))
    await waitFor(() => expect(screen.queryByText('general chatter')).not.toBeInTheDocument())
  })

  it('writes about the Task General shows, visibly, and says when a sent message is not about it', async () => {
    const s = server([server().message(1, 'about pruning', { task_id: 'r1' })])
    const onFilterChange = vi.fn()
    const v = view(s, { props: { filter: 'r1', onFilterChange } })
    await screen.findByText('about pruning')
    expect(within(document.querySelector('.kubecode-composer-about') as HTMLElement).getByText('Pruning')).toBeInTheDocument()
    fireEvent.change(box(), { target: { value: 'one more thought' } })
    send()
    await waitFor(() => expect(s.posted).toHaveLength(1))
    expect(s.posted[0].references).toEqual([{ kind: 'research', id: 'r1', revision: null }])
    expect(await screen.findByText('one more thought')).toBeInTheDocument()
    // Taking the Task off: the message is sent, and General says why it is not shown.
    fireEvent.click(screen.getByRole('button', { name: 'Not about Pruning' }))
    fireEvent.change(box(), { target: { value: 'unrelated' } })
    send()
    expect(await screen.findByText("Sent. It isn't about Pruning, so it isn't shown here.")).toBeInTheDocument()
    fireEvent.click(within(screen.getByText(/isn't shown here/).closest('p') as HTMLElement).getByRole('button', { name: 'Show everything' }))
    expect(onFilterChange).toHaveBeenLastCalledWith(null)
    v.rerenderWith({ filter: null })
    expect(await screen.findByText('unrelated')).toBeInTheDocument()
  })

  it('names references by title, shows the Task once, and opens them where references open', async () => {
    const s = server([
      server().message(1, 'See these', {
        task_id: 'r1',
        references: [{ kind: 'research', id: 'r1' }, { kind: 'session', id: 's9' }, { kind: 'artifact', id: '064a23dd' }],
      }),
    ])
    const onOpenReference = vi.fn()
    view(s, { props: { conversations: [{ id: 's9', project_id: 'p1', title: 'Sweep run' } as Conversation], onOpenReference } })
    await screen.findByText('See these')
    const chips = row(1).querySelectorAll('.kubecode-reference-chip')
    expect([...chips].map((chip) => chip.textContent?.trim())).toEqual(['Task Pruning', 'Session Sweep run', 'Artifact Artifact (no title)'])
    expect(row(1)).not.toHaveTextContent('064a23dd')
    fireEvent.click(within(row(1)).getByRole('button', { name: 'Session Sweep run' }))
    expect(onOpenReference).toHaveBeenCalledWith({ kind: 'session', id: 's9' })
  })

  it('opens references through the Workspace navigation when no handler is given', async () => {
    const navigation = fakeNavigation()
    const s = server([server().message(1, 'See this', { references: [{ kind: 'artifact', id: 'a1' }] })])
    view(s, { navigation })
    fireEvent.click(await screen.findByRole('button', { name: /Artifact/ }))
    expect(navigation.openReference).toHaveBeenCalledWith({ kind: 'artifact', id: 'a1' })
  })

  it('opens the Task of a message beside the conversation', async () => {
    const s = server([server().message(1, 'about pruning', { task_id: 'r1' })])
    const onOpenTask = vi.fn()
    const v = view(s, { props: { onOpenTask } })
    fireEvent.click(await screen.findByRole('button', { name: 'Task Pruning' }))
    expect(onOpenTask).toHaveBeenCalledWith('r1', 'm1')
    v.rerenderWith({ detail: <aside aria-label="Task details">Pruning details</aside>, focusMessageId: 'm1' })
    expect(screen.getByRole('complementary', { name: 'Task details' })).toBeInTheDocument()
    expect(document.querySelector('.kubecode-channel-workspace')).toHaveAttribute('data-detail', 'true')
  })

  it('shows the manager’s proposal as a proposal with where it stands, and never a researcher-typed lookalike', async () => {
    const s = server([
      server().message(1, 'Proposal: prune heads', {
        author_kind: 'agent', author_ref: 's-g', client_message_id: 'proposal:r1:2', task_id: 'r1',
      }),
      server().message(2, 'I typed this id myself', { client_message_id: 'proposal:r1:9', task_id: 'r1' }),
    ])
    view(s, { props: { tasksOnBoard: new Set<string>() } })
    await screen.findByText('Proposal: prune heads')
    expect(screen.getAllByText('Task proposal, revision 2')).toHaveLength(1)
    expect(screen.queryByText('Task proposal, revision 9')).not.toBeInTheDocument()
    expect(screen.getByText('Not on the board yet')).toBeInTheDocument()
    expect(screen.queryByText(/tell the General Agent in your own words/)).not.toBeInTheDocument()
  })

  it('shows on a message that it was not delivered', async () => {
    const s = server([
      server().message(1, '@writer draft it', { mentions: [{ session_id: 's-w' }] }),
      server().message(2, 'Your message was not delivered to the member it names: writer needs setup.', {
        author_kind: 'system', kind: 'system', client_message_id: 'route-denied:m1',
      }),
    ])
    view(s)
    await screen.findByText('@writer draft it')
    const failed = row(1).querySelector('[data-delivery="failed"]')
    expect(failed).toHaveTextContent('Not delivered')
    expect(failed).toHaveTextContent('writer needs setup')
    expect(screen.queryByText(/Activity/)).not.toBeInTheDocument()
  })
})

describe('ChannelWorkspace delivery facts (ADR 0232)', () => {
  it('says under the researcher\'s message to whom it was not delivered, folds the routing note, and retries the same route', async () => {
    const s = server([
      server().message(1, '@writer draft it', { mentions: [{ session_id: 's-w' }] }),
      server().message(2, 'Kubecode could not deliver a message to @writer.', {
        author_kind: 'system', kind: 'system', client_message_id: 'route-failed:rt1',
      }),
      server().message(3, 'On it.', { author_kind: 'agent' }),
    ])
    const failed = messageDelivery({
      message_id: 'm1',
      state: 'failed',
      routes: [routeDelivery({ route_id: 'rt1', state: 'failed', retryable: true, recipient: { id: 'w', name: 'Writer', handle: 'writer', role: 'specialist' }, note_ids: ['m2'] })],
    })
    const messageDeliveries = vi.fn().mockResolvedValue([failed])
    const retryRoute = vi.fn().mockResolvedValue({ route: { id: 'rt1', state: 'pending' }, retried: true, delivery: null })
    Object.assign(s.calls, { messageDeliveries, retryRoute })
    view(s)
    await screen.findByText('@writer draft it')
    expect(await within(row(1)).findByText('Not delivered to Writer')).toBeInTheDocument()
    expect(messageDeliveries).toHaveBeenCalledWith('p1', ['m1'])
    // The note is inside the message's Details, not a row of its own.
    expect(screen.queryByTestId('message-2')).not.toBeInTheDocument()
    expect(within(row(1)).getByText('Kubecode could not deliver a message to @writer.')).toBeInTheDocument()
    fireEvent.click(within(row(1)).getByRole('button', { name: 'Retry delivery to Writer' }))
    await waitFor(() => expect(retryRoute).toHaveBeenCalledWith('p1', 'rt1'))
    // Nothing was posted again.
    expect(s.posted).toHaveLength(0)
  })

  it('says Delivered only under the researcher\'s latest message', async () => {
    const s = server([
      server().message(1, 'first'),
      server().message(2, 'second'),
    ])
    const messageDeliveries = vi.fn().mockResolvedValue([
      messageDelivery({ message_id: 'm1', routes: [routeDelivery({ recipient: { id: 'g', name: 'Gene', handle: 'general', role: 'general' } })] }),
      messageDelivery({ message_id: 'm2', routes: [routeDelivery({ recipient: { id: 'g', name: 'Gene', handle: 'general', role: 'general' } })] }),
    ])
    Object.assign(s.calls, { messageDeliveries })
    view(s)
    await screen.findByText('second')
    expect(await within(row(2)).findByText('Delivered to Gene')).toBeInTheDocument()
    expect(within(row(1)).queryByText('Delivered to Gene')).not.toBeInTheDocument()
  })
})

describe('ChannelWorkspace while members work (ADR 0232)', () => {
  const attention = (runs: ExecutionView[]): AttentionStore => ({
    projectId: 'p1',
    snapshot: snapshot({ executions: runs }),
    status: 'ready',
    forTask: () => [],
    byKey: () => undefined,
    executions: (scope) => ('binding' in scope && scope.binding === 'public' ? runs : []),
    failures: () => [],
    resolving: new Set(),
    markResolving: vi.fn(),
    reload: vi.fn(),
  })

  it('shows who is working above the composer, with the Task\'s one Stop in the strip and none beside Send', async () => {
    const s = server()
    const cancelRun = vi.fn().mockResolvedValue(undefined)
    const taskDetail = vi.fn().mockResolvedValue({ id: 'r1', execution: null })
    Object.assign(s.calls, { cancelRun, taskDetail })
    render(shell(<AttentionContext.Provider value={attention([execution()])}>{workspace(s)}</AttentionContext.Provider>))
    await screen.findByText('No messages yet. Start the discussion.')
    expect(screen.getByRole('region', { name: 'Working now' })).toHaveTextContent('Analyst is working on Structured pruning')
    const stops = screen.getAllByRole('button', { name: /^Stop/ })
    expect(stops).toHaveLength(1)
    expect(stops[0]).toHaveAccessibleName('Stop Structured pruning')
    // Sending stays possible while the member works.
    fireEvent.change(box(), { target: { value: 'Meanwhile, a note' } })
    send()
    await waitFor(() => expect(s.posted).toHaveLength(1))
    fireEvent.click(stops[0])
    await waitFor(() => expect(cancelRun).toHaveBeenCalledWith('run1'))
  })

  it('gives a Task one Stop in the strip when two members work on it', async () => {
    const s = server()
    const runs = [execution(), execution({ run_id: 'run2', conversation_id: 's2', member: { id: 'm9', name: 'Writer', handle: 'writer', role: 'specialist' } })]
    render(shell(<AttentionContext.Provider value={attention(runs)}>{workspace(s)}</AttentionContext.Provider>))
    await screen.findByText('No messages yet. Start the discussion.')
    // Both work on one Task: it has one Stop, in the strip.
    expect(screen.getAllByRole('button', { name: /^Stop / })).toHaveLength(1)
    expect(within(screen.getByRole('region', { name: 'Working now' })).getAllByRole('button', { name: /^Stop / })).toHaveLength(1)
  })
})

describe('ChannelWorkspace earlier Threads (ADR 0229 §5)', () => {
  it('opens an earlier thread read-only, and Reply in General cites its root and focuses the composer', async () => {
    const s = server([server().message(1, 'Pruning heads?', { author_kind: 'agent', author_ref: 's-a', author_member_id: 'a' })])
    s.thread('m1', { reply_count: 1 })
    s.messages.push(server().message(2, 'Try magnitude pruning', { thread_id: 't1' }))
    const onThreadChange = vi.fn()
    view(s, { props: { onThreadChange } })
    fireEvent.click(await screen.findByRole('button', { name: 'Earlier thread · 1 reply' }))
    const pane = await screen.findByRole('complementary', { name: 'Earlier thread' })
    expect(onThreadChange).toHaveBeenLastCalledWith('t1')
    // Read-only says where to reply and the one thing that can change; it offers no reply box.
    expect(within(pane).getByText(
      'Read-only: this thread is from an earlier version. Reply in General; only its link to a Task can change here.',
    )).toBeInTheDocument()
    expect(pane).not.toHaveTextContent('reach no one')
    expect(await within(pane).findByText('Try magnitude pruning')).toBeInTheDocument()
    expect(within(pane).queryByRole('combobox', { name: /Message/ })).not.toBeInTheDocument()
    expect(within(pane).queryByRole('button', { name: /Reply to/ })).not.toBeInTheDocument()
    // The reply stays out of the timeline.
    expect(screen.getAllByText('Try magnitude pruning')).toHaveLength(1)
    fireEvent.click(within(pane).getByRole('button', { name: 'Reply in General' }))
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Earlier thread' })).not.toBeInTheDocument())
    expect(screen.getByText('Replying to Analyst: Pruning heads?')).toBeInTheDocument()
    expect(box()).toHaveValue('@analyst ')
    await waitFor(() => expect(box()).toHaveFocus())
  })

  it('links an earlier thread to a Task round, and reloads when it changed meanwhile', async () => {
    const s = server([server().message(1, 'Topic')])
    s.thread('m1', { reply_count: 2 })
    view(s, { props: { initialThreadId: 't1' } })
    const pane = await screen.findByRole('complementary', { name: 'Earlier thread' })
    fireEvent.change(within(pane).getByLabelText('Research question'), { target: { value: 'r1' } })
    fireEvent.change(await within(pane).findByLabelText('Round'), { target: { value: 'round-1' } })
    fireEvent.click(within(pane).getByRole('button', { name: 'Link' }))
    await waitFor(() => expect(s.calls.linkChannelThread).toHaveBeenCalledWith('p1', 't1', 1, 'r1', 'round-1'))
    s.threads[0] = { ...s.threads[0], revision: 9 }
    fireEvent.change(within(pane).getByLabelText('Research question'), { target: { value: '__none__' } })
    fireEvent.click(within(pane).getByRole('button', { name: 'Unlink' }))
    expect(await within(pane).findByRole('alert')).toHaveTextContent('This thread changed')
  })

  it('opens the work of an earlier thread, and the Thread the route names, without remounting', async () => {
    const s = server([server().message(1, 'a topic')])
    s.thread('m1')
    const onOpenWork = vi.fn()
    const v = view(s, { props: { onOpenWork } })
    await screen.findByText('a topic')
    expect(screen.queryByRole('complementary', { name: 'Earlier thread' })).not.toBeInTheDocument()
    v.rerenderWith({ initialThreadId: 't1' })
    const pane = await screen.findByRole('complementary', { name: 'Earlier thread' })
    fireEvent.click(within(pane).getByRole('button', { name: 'View work from this thread' }))
    expect(onOpenWork).toHaveBeenCalledWith({ thread_id: 't1' })
    v.rerenderWith({ initialThreadId: null })
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Earlier thread' })).not.toBeInTheDocument())
  })
})

describe('ChannelWorkspace dates', () => {
  it('writes days and times in the app language, not the browser’s', async () => {
    const at = { created_at: '2025-01-02 10:00:00' }
    const s = server([
      server().message(1, 'a topic', at),
      server().message(2, 'a note', { author_kind: 'system', kind: 'system', ...at }),
    ])
    view(s, { props: { locale: 'de-DE' } })
    await screen.findByText('a topic')
    const date = new Date('2025-01-02T10:00:00Z')
    const time = date.toLocaleTimeString('de-DE', { hour: 'numeric', minute: '2-digit' })
    expect(time).not.toBe(date.toLocaleTimeString(navigator.language, { hour: 'numeric', minute: '2-digit' }))
    expect(screen.getByRole('separator')).toHaveTextContent(
      date.toLocaleDateString('de-DE', { year: 'numeric', month: 'long', day: 'numeric' }),
    )
    expect(row(1).querySelector('time')).toHaveTextContent(time)
    expect(row(1).querySelector('time')).toHaveAttribute('title', date.toLocaleString('de-DE'))
    expect(row(2).querySelector('time')).toHaveTextContent(time)
  })
})

describe('ChannelWorkspace keeps its place (ADR 0228 §4, ADR 0229 §6)', () => {
  it('keeps the draft and reply of General and of each Task-scoped view apart, across leaving and coming back', async () => {
    const memory = createPlaceMemory()
    const s = server([server().message(1, 'about pruning', { task_id: 'r1' })])
    const v = view(s, { memory, props: { filter: null } })
    await screen.findByText('about pruning')
    fireEvent.click(screen.getByRole('button', { name: 'Reply to You' }))
    fireEvent.change(box(), { target: { value: 'for everyone' } })

    v.rerender(<PlaceMemoryProvider memory={memory}><p>elsewhere</p></PlaceMemoryProvider>)
    v.rerenderWith({ filter: null })
    expect(await screen.findByRole('combobox', { name: 'Message the Workspace' })).toHaveValue('for everyone')
    expect(screen.getByText(/Replying to You:/)).toBeInTheDocument()

    v.rerenderWith({ filter: 'r1' })
    expect(box()).toHaveValue('')
    expect(screen.queryByText(/Replying to You:/)).not.toBeInTheDocument()
    fireEvent.change(box(), { target: { value: 'about r1' } })
    v.rerenderWith({ filter: null })
    expect(box()).toHaveValue('for everyone')
    v.rerenderWith({ filter: 'r1' })
    expect(box()).toHaveValue('about r1')
  })

  it('keeps a send in flight, its failure, and Try again with the view of General it was sent from', async () => {
    const memory = createPlaceMemory()
    const s = server()
    let fail: (cause: Error) => void = () => undefined
    vi.mocked(s.calls.postChannelMessage)
      .mockImplementationOnce(() => new Promise<ChannelMessage>((_, reject) => { fail = reject }))
    const v = view(s, { memory, props: { filter: null } })
    await screen.findByText('No messages yet. Start the discussion.')
    fireEvent.change(box(), { target: { value: 'for everyone' } })
    send()
    await waitFor(() => expect(screen.queryAllByText('Sending…').length).toBeGreaterThan(0))
    v.rerenderWith({ filter: 'r1' })
    expect(screen.queryAllByText('Sending…')).toHaveLength(0)
    fireEvent.change(box(), { target: { value: 'about r1' } })
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
    await act(async () => { fail(new Error('network down')) })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(box()).toHaveValue('about r1')
    v.rerenderWith({ filter: null })
    expect(await screen.findByRole('alert')).toHaveTextContent('Not sent: network down')
    expect(screen.getByRole('list', { name: 'Unsent messages' })).toHaveTextContent('for everyone')
    expect(box()).toHaveValue('')
  })

  it('names its rows and its composer for scroll and focus return', async () => {
    const s = server([server().message(1, 'a topic'), server().message(2, 'a note', { author_kind: 'system', kind: 'system' })])
    view(s)
    await screen.findByText('a topic')
    expect(row(1)).toHaveAttribute('data-scroll-anchor', 'm1')
    expect(row(1)).toHaveAttribute('data-focus-key', 'message:m1')
    expect(row(2)).toHaveAttribute('data-scroll-anchor', 'm2')
    expect(box()).toHaveAttribute('data-focus-key', 'composer:general')
  })

  it('reports where the researcher is reading and what had focus', async () => {
    const s = server(Array.from({ length: 6 }, (_, index) => server().message(index + 1, `message ${index + 1}`)))
    const onReadingPositionChange = vi.fn()
    view(s, { props: { onReadingPositionChange } })
    await screen.findByText('message 6')
    const log = screen.getByRole('log')
    let top = 0
    Object.defineProperty(log, 'scrollTop', { configurable: true, get: () => top, set: (value: number) => { top = value } })
    Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => 240 })
    Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => 100 })
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const id = this.getAttribute('data-message-id')
      const y = id ? (Number(id.slice(1)) - 1) * 40 - top : 0
      return { top: y, bottom: y + (id ? 40 : 100), height: id ? 40 : 100, left: 0, right: 0, width: 0, x: 0, y } as DOMRect
    })
    try {
      fireEvent.focus(box())
      expect(onReadingPositionChange).toHaveBeenLastCalledWith({ messageId: null, atLatest: false, focus: 'composer' })
      fireEvent.focus(screen.getByLabelText('Show messages about'))
      top = 40
      fireEvent.scroll(log)
      await waitFor(() => expect(onReadingPositionChange).toHaveBeenLastCalledWith({ messageId: 'm3', atLatest: false, focus: null }))
      fireEvent.focus(box())
      expect(onReadingPositionChange).toHaveBeenLastCalledWith({ messageId: 'm3', atLatest: false, focus: 'composer' })
      top = 140
      fireEvent.scroll(log)
      await waitFor(() => expect(onReadingPositionChange).toHaveBeenLastCalledWith(expect.objectContaining({ atLatest: true })))
    } finally {
      rect.mockRestore()
    }
  })

  it('finds an old linked message, loads around it, and catches up to the latest', async () => {
    Element.prototype.scrollIntoView = vi.fn()
    const s = server(Array.from({ length: 120 }, (_, index) => server().message(index + 1, `message ${index + 1}`)))
    view(s, { props: { focusMessageId: 'm5' } })
    await waitFor(() => expect(s.calls.getChannelMessage).toHaveBeenCalledWith('p1', 'c1', 'm5'))
    expect(await screen.findByText('message 5')).toBeInTheDocument()
    await waitFor(() => expect(document.getElementById('message-m5')).toHaveFocus())
    expect(await screen.findByText('message 120')).toBeInTheDocument()
    expect(screen.getByText('message 60')).toBeInTheDocument()
  })

  it('lands on a message quietly, or in the composer, when asked to', async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    const s = server([server().message(1, 'a topic'), server().message(2, 'a reply')])
    const quiet = view(s, { props: { focusMessageId: 'm1', landing: 'quiet' } })
    await screen.findByText('a topic')
    await waitFor(() => expect(scroll).toHaveBeenCalled())
    expect(document.getElementById('message-m1')).not.toHaveFocus()
    quiet.unmount()

    view(s, { props: { focusMessageId: 'm1', landing: 'composer' } })
    await screen.findByText('a topic')
    await waitFor(() => expect(box()).toHaveFocus())
  })

  it('makes the conversation inert while a full-screen detail covers it', async () => {
    const s = server([server().message(1, 'a topic')])
    view(s, { props: { detail: <aside aria-label="Task details" />, detailCovers: true } })
    await screen.findByText('a topic')
    expect(document.querySelector('.kubecode-channel-main')).toHaveAttribute('inert')
    expect(screen.getByText('a topic')).toBeInTheDocument()
  })
})
