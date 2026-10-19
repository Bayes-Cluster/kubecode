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
    client_message_id: null, intent_claimed_by: null, created_at: '2026-10-18 10:00:00', ...extra,
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
      options: { threadId?: string | null; beforeSeq?: number; afterSeq?: number; limit?: number } = {},
    ) => {
      const limit = options.limit ?? 50
      const scoped = messages.filter(inScope(options.threadId))
      if (options.afterSeq !== undefined) {
        const page = scoped.filter((m) => m.seq > options.afterSeq!).slice(0, limit)
        return { messages: page, has_more: false }
      }
      const before = scoped.filter((m) => m.seq < (options.beforeSeq ?? Infinity))
      const page = before.slice(-limit)
      return { messages: page, has_more: before.length > page.length }
    }),
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
  props: { events?: WorkspaceEvent[]; connection?: 'live' | 'reconnecting' } = {},
) {
  const ui = (events: WorkspaceEvent[]) => (
    <ChannelWorkspace
      api={s.api}
      connectionState={props.connection ?? 'live'}
      conversations={sessions}
      events={events}
      onClose={vi.fn()}
      onOpenResearch={vi.fn()}
      onOpenSession={vi.fn()}
      projectId="p1"
      research={[question]}
      t={t}
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
        onClose={vi.fn()}
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
        onClose={vi.fn()}
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
        onClose={vi.fn()}
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
        onClose={vi.fn()}
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
})
