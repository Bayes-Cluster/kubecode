import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type {
  ChannelMessage,
  ChannelThread,
  Conversation,
  KubecodeApi,
  NewChannelMessage,
  ResearchSummary,
  WorkspaceEvent,
} from '../api'
import { ApiError } from '../api'
import { createPlaceMemory, type PlaceMemory } from '../app/location/placeMemory'
import { PlaceMemoryProvider } from '../app/location/PlaceMemoryProvider'
import { ChannelWorkspace } from './ChannelWorkspace'

const t = ((key: string, values?: Record<string, string | number>) => (
  values ? `${key}:${JSON.stringify(values)}` : key
)) as never

const channel = {
  id: 'c1', project_id: 'p1', name: 'general', is_default: true, last_seq: 0, created_at: '2026-10-18 10:00:00',
}

const question: ResearchSummary = {
  id: 'r1', project_id: 'p1', title: 'Pruning', status: 'open', archived: false,
  revision: 1, entry_count: 0, link_count: 0, updated_at: '',
}

/** A tiny in-memory conversation server with the real API's replay and revision rules. */
function server(initial: ChannelMessage[] = []) {
  const messages = [...initial]
  const threads: ChannelThread[] = []
  const posted: NewChannelMessage[] = []
  let failNext = 0
  const message = (seq: number, body: string, extra: Partial<ChannelMessage> = {}): ChannelMessage => ({
    id: `m${seq}`, project_id: 'p1', channel_id: 'c1', thread_id: null, seq, kind: 'message',
    author_kind: 'researcher', author_ref: null, body, intent: 'say', mentions: [], references: [],
    client_message_id: null, intent_claimed_by: null, created_at: '2026-10-18 10:00:00',
    task_id: null, reply_to: null, hops: 0, ...extra,
  })
  const inScope = (threadId: string | null | undefined) => (candidate: ChannelMessage) => {
    if (!threadId) return candidate.thread_id === null
    const thread = threads.find((item) => item.id === threadId)
    return candidate.thread_id === threadId || candidate.id === thread?.root_message_id
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
      const created = message(messages.length + 1, input.body, {
        thread_id: input.threadId ?? null,
        client_message_id: input.clientMessageId ?? null,
        intent: input.intent ?? 'say',
        mentions: input.mentions ?? [],
        references: input.references ?? [],
        reply_to: input.replyTo ?? null,
      })
      messages.push(created)
      return created
    }),
    listChannelThreads: vi.fn(async () => [...threads]),
    startChannelThread: vi.fn(async (_p: string, _c: string, root: string) => {
      const found = messages.find((m) => m.id === root)!
      const thread: ChannelThread = {
        id: `t${threads.length + 1}`, project_id: 'p1', channel_id: 'c1', root_message_id: root,
        title: found.body, research_id: null, round_id: null, revision: 1,
        reply_count: 0, last_seq: found.seq, created_by: 'researcher',
        created_at: '', updated_at: '',
      }
      threads.push(thread)
      return thread
    }),
    listResearchRounds: vi.fn(async () => [{ id: 'round-1', research_id: 'r1', round: 1 }]),
    linkChannelThread: vi.fn(async (
      _p: string, id: string, revision: number, researchId: string | null, roundId: string | null = null,
    ) => {
      const thread = threads.find((item) => item.id === id)!
      if (thread.revision !== revision) {
        throw new ApiError('thread_revision_conflict', 'changed', 409)
      }
      thread.research_id = researchId
      thread.round_id = roundId
      thread.revision += 1
      return thread
    }),
  }
  return {
    api: api as unknown as KubecodeApi,
    calls: api,
    messages,
    posted,
    threads,
    message,
    failNext: (count: number) => { failNext = count },
  }
}

const sessions: Conversation[] = []

function view(
  s: ReturnType<typeof server>,
  props: {
    events?: WorkspaceEvent[]
    connection?: 'live' | 'reconnecting'
    extra?: Partial<React.ComponentProps<typeof ChannelWorkspace>>
  } = {},
) {
  const ui = (events: WorkspaceEvent[]) => (
    <ChannelWorkspace
      api={s.api}
      connectionState={props.connection ?? 'live'}
      conversations={sessions}
      events={events}
      onOpenResearch={vi.fn()}
      onOpenSession={vi.fn()}
      projectId="p1"
      research={[question]}
      t={t}
      {...props.extra}
    />
  )
  const result = render(ui(props.events ?? []))
  return { ...result, rerenderWith: (events: WorkspaceEvent[]) => result.rerender(ui(events)) }
}

const channelEvent = (id: number, threadId: string | null = null): WorkspaceEvent => ({
  id, kind: 'channel_updated', project_id: 'p1', conversation_id: null, run_id: null,
  payload: { channel_id: 'c1', thread_id: threadId, change: 'message' }, created_at: '',
})

describe('ChannelWorkspace', () => {
  it('shows the empty channel, posts a message, and keeps one client id across a failed send', async () => {
    const s = server()
    view(s)
    expect(await screen.findByText('kubecode.channel.empty')).toBeInTheDocument()
    const box = screen.getByLabelText('kubecode.channel.composerPlaceholder')
    fireEvent.change(box, { target: { value: '  Should we prune?  ' } })
    s.failNext(1)
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.channel.send' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('network down')
    expect(box).toHaveValue('  Should we prune?  ')
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.channel.send' }))
    expect(await screen.findByText('Should we prune?')).toBeInTheDocument()
    expect(s.posted).toHaveLength(2)
    expect(s.posted[1].clientMessageId).toBe(s.posted[0].clientMessageId)
    expect(s.posted[1].body).toBe('Should we prune?')
    expect(box).toHaveValue('')
    // The next message is a new one.
    fireEvent.change(box, { target: { value: 'Another' } })
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.channel.send' }))
    await screen.findByText('Another')
    expect(s.posted[2].clientMessageId).not.toBe(s.posted[0].clientMessageId)
    expect(s.messages).toHaveLength(2)
  })

  it('converges on channel events and on a reconnect without repeating messages', async () => {
    const s = server([])
    const v = view(s)
    await screen.findByText('kubecode.channel.empty')
    s.messages.push(s.message(1, 'from elsewhere'))
    await act(async () => v.rerenderWith([channelEvent(5)]))
    expect(await screen.findByText('from elsewhere')).toBeInTheDocument()
    s.messages.push(s.message(2, 'second'))
    await act(async () => v.rerenderWith([channelEvent(5), channelEvent(6)]))
    expect(await screen.findByText('second')).toBeInTheDocument()
    expect(screen.getAllByText('from elsewhere')).toHaveLength(1)
  })

  it('shows the latest page and loads earlier messages on request', async () => {
    const initial = Array.from({ length: 60 }, (_, index) => (
      server().message(index + 1, `message ${index + 1}`)
    ))
    const s = server(initial)
    view(s)
    expect(await screen.findByText('message 60')).toBeInTheDocument()
    expect(screen.queryByText('message 10')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.channel.loadOlder' }))
    expect(await screen.findByText('message 10')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'kubecode.channel.loadOlder' })).not.toBeInTheDocument()
  })

  it('starts a thread on a message, replies there, and links it to a research question', async () => {
    const s = server([server().message(1, 'Pruning heads?')])
    view(s)
    await screen.findByText('Pruning heads?')
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.channel.reply' }))
    const pane = await screen.findByRole('complementary', { name: 'kubecode.channel.thread' })
    expect(s.calls.startChannelThread).toHaveBeenCalledWith('p1', 'c1', 'm1')
    expect(await within(pane).findByTestId('message-1')).toHaveTextContent('Pruning heads?')

    fireEvent.change(
      within(pane).getByLabelText('kubecode.channel.threadPlaceholder'),
      { target: { value: 'Try magnitude pruning' } },
    )
    fireEvent.click(within(pane).getByRole('button', { name: 'kubecode.channel.send' }))
    expect(await within(pane).findByText('Try magnitude pruning')).toBeInTheDocument()
    expect(s.posted.at(-1)?.threadId).toBe('t1')
    // The reply stays out of the channel timeline.
    expect(screen.getAllByText('Try magnitude pruning')).toHaveLength(1)

    fireEvent.change(within(pane).getByLabelText('kubecode.channel.linkLabel'), { target: { value: 'r1' } })
    fireEvent.click(within(pane).getByRole('button', { name: 'kubecode.channel.link' }))
    await waitFor(() => expect(s.calls.linkChannelThread).toHaveBeenCalledWith('p1', 't1', 1, 'r1', null))
    expect(await within(pane).findByText('kubecode.channel.linkedTo:{"title":"Pruning"}')).toBeInTheDocument()
  })

  it('reloads and says so when the thread changed under a link attempt', async () => {
    const s = server([server().message(1, 'Topic')])
    view(s)
    fireEvent.click(await screen.findByRole('button', { name: 'kubecode.channel.reply' }))
    const pane = await screen.findByRole('complementary', { name: 'kubecode.channel.thread' })
    s.threads[0] = { ...s.threads[0], revision: 4 }
    fireEvent.change(within(pane).getByLabelText('kubecode.channel.linkLabel'), { target: { value: 'r1' } })
    fireEvent.click(within(pane).getByRole('button', { name: 'kubecode.channel.link' }))
    expect(await within(pane).findByRole('alert')).toHaveTextContent('kubecode.channel.error.threadChanged')
  })

  it('records an ask only with a Session to ask, and a request with its hint', async () => {
    const s = server()
    const asked: Conversation = {
      id: 's1', project_id: 'p1', title: 'Analyst', archived: false, team_id: null,
      relationship: 'standalone',
    } as unknown as Conversation
    sessions.push(asked)
    try {
      view(s)
      await screen.findByText('kubecode.channel.empty')
      const box = screen.getByLabelText('kubecode.channel.composerPlaceholder')
      fireEvent.change(box, { target: { value: 'What do you think?' } })
      fireEvent.change(screen.getByLabelText('kubecode.channel.intent.label'), { target: { value: 'ask' } })
      expect(screen.getByRole('button', { name: 'kubecode.channel.send' })).toBeDisabled()
      fireEvent.change(screen.getByLabelText('kubecode.channel.askSession'), { target: { value: 's1' } })
      fireEvent.click(screen.getByRole('button', { name: 'kubecode.channel.send' }))
      await screen.findByText('What do you think?')
      expect(s.posted[0]).toMatchObject({ intent: 'ask', mentions: [{ session_id: 's1' }] })

      fireEvent.change(box, { target: { value: 'Run the sweep' } })
      fireEvent.change(screen.getByLabelText('kubecode.channel.intent.label'), { target: { value: 'request' } })
      expect(screen.getByText('kubecode.channel.intent.requestHint')).toBeInTheDocument()
    } finally {
      sessions.length = 0
    }
  })

  it('reports a failed load and tolerates a host without a conversation', async () => {
    const s = server()
    s.calls.listChannelMessages.mockRejectedValue(new Error('down'))
    view(s)
    await waitFor(() => expect(screen.getAllByText(/kubecode.channel.loadFailed/).length).toBeGreaterThan(0))
    const bare = { ...s.api, listChannels: undefined, listChannelMessages: undefined } as unknown as KubecodeApi
    render(
      <ChannelWorkspace
        api={bare}
        connectionState="live"
        conversations={[]}
        events={[]}
        onOpenResearch={vi.fn()}
        onOpenSession={vi.fn()}
        projectId="p1"
        research={[]}
        t={t}
      />,
    )
  })
})

describe('ChannelWorkspace details', () => {
  it('edits after a failed send become a new message instead of reusing a stuck id', async () => {
    const s = server()
    view(s)
    await screen.findByText('kubecode.channel.empty')
    const box = screen.getByLabelText('kubecode.channel.composerPlaceholder')
    fireEvent.change(box, { target: { value: 'first draft' } })
    s.failNext(1)
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.channel.send' }))
    await screen.findByRole('alert')
    // An unchanged retry replays the same id; an edited draft gets a fresh one.
    fireEvent.change(box, { target: { value: 'first draft, edited' } })
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.channel.send' }))
    await screen.findByText('first draft, edited')
    expect(s.posted[1].clientMessageId).not.toBe(s.posted[0].clientMessageId)
  })

  it('links a thread to one round of its question', async () => {
    const s = server([server().message(1, 'Topic')])
    view(s)
    fireEvent.click(await screen.findByRole('button', { name: 'kubecode.channel.reply' }))
    const pane = await screen.findByRole('complementary', { name: 'kubecode.channel.thread' })
    fireEvent.change(within(pane).getByLabelText('kubecode.channel.linkLabel'), { target: { value: 'r1' } })
    fireEvent.change(await within(pane).findByLabelText('kubecode.channel.roundLabel'), { target: { value: 'round-1' } })
    fireEvent.click(within(pane).getByRole('button', { name: 'kubecode.channel.link' }))
    await waitFor(() => expect(s.calls.linkChannelThread).toHaveBeenCalledWith('p1', 't1', 1, 'r1', 'round-1'))
  })

  it('opens research questions, Sessions, and Threads from reference chips', async () => {
    const reference = (kind: 'research' | 'session', id: string) => ({ kind, id })
    const s = server([
      server().message(1, 'See these', {
        references: [reference('research', 'r1'), reference('session', 's9')],
      }),
    ])
    const onOpenResearch = vi.fn()
    const onOpenSession = vi.fn()
    render(
      <ChannelWorkspace
        api={s.api}
        connectionState="live"
        conversations={[]}
        events={[]}
        onOpenResearch={onOpenResearch}
        onOpenSession={onOpenSession}
        projectId="p1"
        research={[question]}
        t={t}
      />,
    )
    await screen.findByText('See these')
    fireEvent.click(screen.getByRole('button', { name: /kubecode.projectWorkKindResearch/ }))
    fireEvent.click(screen.getByRole('button', { name: /projectWorkKindSession(?!Turn)/ }))
    expect(onOpenResearch).toHaveBeenCalledWith('r1')
    expect(onOpenSession).toHaveBeenCalledWith('s9')
  })

  it('opens a requested thread on arrival', async () => {
    const s = server([server().message(1, 'Root')])
    await s.api.startChannelThread('p1', 'c1', 'm1')
    render(
      <ChannelWorkspace
        api={s.api}
        connectionState="live"
        conversations={[]}
        events={[]}
        initialThreadId="t1"
        onOpenResearch={vi.fn()}
        onOpenSession={vi.fn()}
        projectId="p1"
        research={[question]}
        t={t}
      />,
    )
    expect(await screen.findByRole('complementary', { name: 'kubecode.channel.thread' })).toBeInTheDocument()
  })
})

describe('ChannelWorkspace work entry', () => {
  it('opens the one work board filtered to a Thread from its pane', async () => {
    const s = server([server().message(1, 'Topic')])
    const onOpenWork = vi.fn()
    render(
      <ChannelWorkspace
        api={s.api}
        connectionState="live"
        conversations={[]}
        events={[]}
        onOpenResearch={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenWork={onOpenWork}
        projectId="p1"
        research={[question]}
        t={t}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'kubecode.channel.reply' }))
    const pane = await screen.findByRole('complementary', { name: 'kubecode.channel.thread' })
    fireEvent.click(within(pane).getByRole('button', { name: 'kubecode.channel.openWork' }))
    expect(onOpenWork).toHaveBeenCalledWith({ thread_id: 't1' })
  })

  it('offers active members with a public Session as @mentions and records the Session on the message', async () => {
    const s = server()
    ;(s.calls as unknown as Record<string, unknown>).listMembers = vi.fn(async () => ({
      members: [
        { id: 'm-general', state: 'active', handle: 'general', name: 'General', public_conversation_id: 'sess-general' },
        { id: 'm-gone', state: 'removed', handle: 'gone', name: 'Gone', public_conversation_id: 'sess-gone' },
        { id: 'm-none', state: 'active', handle: 'nosession', name: 'No Session', public_conversation_id: null },
      ],
    }))
    view(s)
    const box = await screen.findByRole('combobox', { name: 'kubecode.channel.composerPlaceholder' })
    fireEvent.change(box, { target: { value: '@', selectionStart: 1 } })
    const options = within(await screen.findByRole('listbox')).getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveTextContent('@general')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(box).toHaveValue('@general ')
    fireEvent.change(box, { target: { value: '@general what next?', selectionStart: 19 } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await screen.findByText('@general what next?')
    expect(s.posted[0].mentions).toEqual([{ session_id: 'sess-general' }])
  })

  it('shows only what is about one Task as a view of the same messages, and the chip sets the filter', async () => {
    const s = server([
      { ...server().message(1, 'about pruning'), task_id: 'r1' },
      server().message(2, 'general chatter'),
    ])
    view(s)
    await screen.findByText('about pruning')
    expect(screen.getByText('general chatter')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('kubecode.channel.filterTask'), { target: { value: 'r1' } })
    await waitFor(() => expect(screen.queryByText('general chatter')).not.toBeInTheDocument())
    expect(screen.getByText('about pruning')).toBeInTheDocument()
    expect(s.calls.listChannelMessages).toHaveBeenLastCalledWith(
      'p1', 'c1', expect.objectContaining({ taskId: 'r1' }),
    )
    fireEvent.change(screen.getByLabelText('kubecode.channel.filterTask'), { target: { value: '' } })
    expect(await screen.findByText('general chatter')).toBeInTheDocument()
    // The chip on a message selects that Task.
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.channel.taskChip:{"title":"Pruning"}' }))
    await waitFor(() => expect(screen.queryByText('general chatter')).not.toBeInTheDocument())
  })

  it('cites a message in the next one, jumps back to it, and keeps routing notes collapsed', async () => {
    const s = server([
      server().message(1, 'the plan'),
      server().message(2, 'noted', { reply_to: 'm1' }),
      server().message(3, 'delivered to the manager', { author_kind: 'system' }),
      server().message(5, 'Review outcome: accepted', { author_kind: 'system', task_id: 'r1' }),
      server().message(4, 'over to you', {
        author_kind: 'agent', author_ref: 'sess-a', mentions: [{ session_id: 'sess-b' }], hops: 1,
      }),
    ])
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    view(s)
    await screen.findByText('the plan')
    // A routing note is one quiet, expandable line.
    const note = screen.getByTestId('message-3')
    expect(note.tagName).toBe('DETAILS')
    expect(note).not.toHaveAttribute('open')
    // A decision about a Task is shown, not folded away.
    expect(screen.getByTestId('message-5').tagName).toBe('ARTICLE')
    expect(screen.getByText('Review outcome: accepted')).toBeVisible()
    // A hand-off says who it was handed to.
    expect(screen.getByText(/kubecode\.channel\.handedTo/)).toBeInTheDocument()
    // The citation names the cited message and jumps to it.
    fireEvent.click(screen.getByRole('button', { name: /kubecode\.channel\.citation:/ }))
    expect(scroll).toHaveBeenCalled()
    expect(document.getElementById('message-m1')).toHaveFocus()
    // Replying cites the message in what is sent, and clears afterwards.
    fireEvent.click(within(screen.getByTestId('message-1')).getByRole('button', { name: 'kubecode.channel.replyToMessage' }))
    expect(screen.getByText(/kubecode\.channel\.replyingTo/)).toBeInTheDocument()
    const box = screen.getByLabelText('kubecode.channel.composerPlaceholder')
    fireEvent.change(box, { target: { value: 'agreed' } })
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.channel.send' }))
    await screen.findByText('agreed')
    expect(s.posted[0].replyTo).toBe('m1')
    await waitFor(() => expect(screen.queryByText(/kubecode\.channel\.replyingTo/)).not.toBeInTheDocument())
  })

  it('keeps what is written while looking at a Task about that Task, so it stays in view', async () => {
    const s = server([{ ...server().message(1, 'about pruning'), task_id: 'r1' }])
    view(s)
    await screen.findByText('about pruning')
    fireEvent.change(screen.getByLabelText('kubecode.channel.filterTask'), { target: { value: 'r1' } })
    const box = screen.getByLabelText('kubecode.channel.composerPlaceholder')
    fireEvent.change(box, { target: { value: 'one more thought' } })
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.channel.send' }))
    expect(s.posted[0] ?? (await waitFor(() => { expect(s.posted.length).toBeGreaterThan(0); return s.posted[0] }))).toBeTruthy()
    expect(s.posted[0].references).toEqual([{ kind: 'research', id: 'r1', revision: null }])
  })

  it('opens the Task of a message beside the conversation and lands back on the message', async () => {
    const s = server([{ ...server().message(1, 'about pruning'), task_id: 'r1' }])
    const onOpenTask = vi.fn()
    const v = view(s, { extra: { onOpenTask, focusMessageId: null } })
    fireEvent.click(await screen.findByRole('button', { name: 'kubecode.channel.taskChip:{"title":"Pruning"}' }))
    expect(onOpenTask).toHaveBeenCalledWith('r1', 'm1')
    // With the detail open it sits beside the conversation (the stylesheet shows one at a time on a phone).
    v.rerender(
      <ChannelWorkspace
        api={s.api}
        connectionState="live"
        conversations={sessions}
        detail={<aside aria-label="Task details">Pruning details</aside>}
        events={[]}
        focusMessageId="m1"
        onOpenResearch={vi.fn()}
        onOpenSession={vi.fn()}
        projectId="p1"
        research={[question]}
        t={t}
      />,
    )
    expect(screen.getByRole('complementary', { name: 'Task details' })).toBeInTheDocument()
    expect(document.querySelector('.kubecode-channel-workspace')).toHaveAttribute('data-detail', 'true')
  })

  it('finds an old linked message, loads around it, and catches up to the latest', async () => {
    Element.prototype.scrollIntoView = vi.fn()
    const many = Array.from({ length: 120 }, (_, index) => server().message(index + 1, `message ${index + 1}`))
    const s = server(many)
    view(s, { extra: { focusMessageId: 'm5' } })
    await waitFor(() => expect(s.calls.getChannelMessage).toHaveBeenCalledWith('p1', 'c1', 'm5'))
    const old = await screen.findByText('message 5')
    expect(old).toBeInTheDocument()
    await waitFor(() => expect(document.getElementById('message-m5')).toHaveFocus())
    // The list is contiguous up to the newest message.
    expect(await screen.findByText('message 120')).toBeInTheDocument()
    expect(screen.getByText('message 60')).toBeInTheDocument()
  })

  it('opens another Thread when the route says so, without remounting the conversation', async () => {
    const s = server([server().message(1, 'a topic')])
    s.threads.push({
      id: 't1', project_id: 'p1', channel_id: 'c1', root_message_id: 'm1', title: 'a topic', research_id: null,
      round_id: null, revision: 1, reply_count: 0, last_seq: 1, created_by: null, created_at: '', updated_at: '',
    })
    const v = view(s, { extra: { initialThreadId: null } })
    await screen.findByText('a topic')
    expect(screen.queryByRole('complementary', { name: 'kubecode.channel.thread' })).not.toBeInTheDocument()
    const props = (initialThreadId: string | null) => (
      <ChannelWorkspace
        api={s.api}
        connectionState="live"
        conversations={sessions}
        events={[]}
        initialThreadId={initialThreadId}
        onOpenResearch={vi.fn()}
        onOpenSession={vi.fn()}
        projectId="p1"
        research={[question]}
        t={t}
      />
    )
    v.rerender(props('t1'))
    expect(await screen.findByRole('complementary', { name: 'kubecode.channel.thread' })).toBeInTheDocument()
    v.rerender(props(null))
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'kubecode.channel.thread' })).not.toBeInTheDocument())
  })

  it('shows the manager\'s proposal as a proposal with where it stands, and never a researcher-typed lookalike', async () => {
    const s = server([
      server().message(1, 'Proposal: prune heads', {
        author_kind: 'agent', author_ref: 'sess-g', client_message_id: 'proposal:r1:2', task_id: 'r1',
      }),
      server().message(2, 'I typed this id myself', { client_message_id: 'proposal:r1:9', task_id: 'r1' }),
    ])
    view(s, { extra: { tasksOnBoard: new Set<string>() } })
    await screen.findByText('Proposal: prune heads')
    expect(screen.getAllByText('kubecode.task.proposalBadge:{"revision":2}')).toHaveLength(1)
    expect(screen.queryByText('kubecode.task.proposalBadge:{"revision":9}')).not.toBeInTheDocument()
    expect(screen.getByText('kubecode.task.notOnBoardYet')).toBeInTheDocument()
    expect(screen.getByText('kubecode.task.proposalHint')).toBeInTheDocument()
  })
})

describe('ChannelWorkspace keeps its place (ADR 0228 §4)', () => {
  function placed(memory: PlaceMemory, s: ReturnType<typeof server>, extra: Partial<React.ComponentProps<typeof ChannelWorkspace>> = {}) {
    return (
      <PlaceMemoryProvider memory={memory}>
        <ChannelWorkspace
          api={s.api}
          connectionState="live"
          conversations={sessions}
          events={[]}
          onOpenResearch={vi.fn()}
          onOpenSession={vi.fn()}
          projectId="p1"
          research={[question]}
          t={t}
          {...extra}
        />
      </PlaceMemoryProvider>
    )
  }

  it('keeps the draft and the reply target of General and of each Task-scoped view when it is left', async () => {
    const memory = createPlaceMemory()
    const s = server([{ ...server().message(1, 'about pruning'), task_id: 'r1' }])
    const v = render(placed(memory, s, { filter: null }))
    await screen.findByText('about pruning')
    fireEvent.click(within(screen.getByTestId('message-1')).getByRole('button', { name: 'kubecode.channel.replyToMessage' }))
    fireEvent.change(screen.getByLabelText('kubecode.channel.composerPlaceholder'), { target: { value: 'for everyone' } })

    v.rerender(<PlaceMemoryProvider memory={memory}><p>elsewhere</p></PlaceMemoryProvider>)
    v.rerender(placed(memory, s, { filter: null }))
    expect(await screen.findByLabelText('kubecode.channel.composerPlaceholder')).toHaveValue('for everyone')
    expect(screen.getByText(/kubecode\.channel\.replyingTo/)).toBeInTheDocument()

    // Looking at one Task is its own draft; the General one never moves there.
    v.rerender(placed(memory, s, { filter: 'r1' }))
    expect(screen.getByLabelText('kubecode.channel.composerPlaceholder')).toHaveValue('')
    expect(screen.queryByText(/kubecode\.channel\.replyingTo/)).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('kubecode.channel.composerPlaceholder'), { target: { value: 'about r1' } })
    v.rerender(placed(memory, s, { filter: null }))
    expect(screen.getByLabelText('kubecode.channel.composerPlaceholder')).toHaveValue('for everyone')
    v.rerender(placed(memory, s, { filter: 'r1' }))
    expect(screen.getByLabelText('kubecode.channel.composerPlaceholder')).toHaveValue('about r1')
  })

  it('names its rows and its composer for scroll and focus return', async () => {
    const s = server([server().message(1, 'a topic'), server().message(2, 'a note', { author_kind: 'system' })])
    view(s)
    await screen.findByText('a topic')
    expect(screen.getByTestId('message-1')).toHaveAttribute('data-scroll-anchor', 'm1')
    expect(screen.getByTestId('message-1')).toHaveAttribute('data-focus-key', 'message:m1')
    expect(screen.getByTestId('message-2')).toHaveAttribute('data-scroll-anchor', 'm2')
    expect(screen.getByLabelText('kubecode.channel.composerPlaceholder')).toHaveAttribute('data-focus-key', 'composer:general')
  })

  it('reports where the researcher is reading and what had focus', async () => {
    const s = server(Array.from({ length: 6 }, (_, index) => server().message(index + 1, `message ${index + 1}`)))
    const onReadingPositionChange = vi.fn()
    view(s, { extra: { onReadingPositionChange } })
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
      // Focus alone says nothing of where the reader is.
      fireEvent.focus(screen.getByLabelText('kubecode.channel.composerPlaceholder'))
      expect(onReadingPositionChange).toHaveBeenLastCalledWith({ messageId: null, atLatest: false, focus: 'composer' })
      fireEvent.focus(screen.getByLabelText('kubecode.channel.filterTask'))
      top = 40
      fireEvent.scroll(log)
      // The message across the middle of the log (50px down) is m3.
      await waitFor(() => expect(onReadingPositionChange).toHaveBeenLastCalledWith({ messageId: 'm3', atLatest: false, focus: null }))
      fireEvent.focus(screen.getByLabelText('kubecode.channel.composerPlaceholder'))
      expect(onReadingPositionChange).toHaveBeenLastCalledWith({ messageId: 'm3', atLatest: false, focus: 'composer' })
      top = 140
      fireEvent.scroll(log)
      await waitFor(() => expect(onReadingPositionChange).toHaveBeenLastCalledWith(expect.objectContaining({ atLatest: true })))
    } finally {
      rect.mockRestore()
    }
  })

  it('lands on a message quietly, or in the composer, when asked to', async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    const s = server([server().message(1, 'a topic'), server().message(2, 'a reply')])
    const quiet = view(s, { extra: { focusMessageId: 'm1', landing: 'quiet' } })
    await screen.findByText('a topic')
    await waitFor(() => expect(scroll).toHaveBeenCalled())
    expect(document.getElementById('message-m1')).not.toHaveFocus()
    quiet.unmount()

    view(s, { extra: { focusMessageId: 'm1', landing: 'composer' } })
    await screen.findByText('a topic')
    await waitFor(() => expect(screen.getByLabelText('kubecode.channel.composerPlaceholder')).toHaveFocus())
  })

  it('makes the conversation inert while a full-screen detail covers it', async () => {
    const s = server([server().message(1, 'a topic')])
    view(s, { extra: { detail: <aside aria-label="Task details" />, detailCovers: true } })
    await screen.findByText('a topic')
    const main = document.querySelector('.kubecode-channel-main')
    expect(main).toHaveAttribute('inert')
    expect(screen.getByText('a topic')).toBeInTheDocument()
  })
})
