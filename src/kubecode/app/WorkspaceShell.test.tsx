import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { KubecodeApp } from '../App'

import type { ChannelMessage, ChannelThread, KubecodeApi, Member, TaskCard } from '../api'

const member = (overrides: Partial<Member>): Member => ({
  id: 'm-general', project_id: 'project-1', role: 'general', template: 'general', name: 'General',
  handle: 'general', spec: { agent_id: 'opencode', config: {}, instructions: 'Manage.' },
  public_conversation_id: 's1', dm_conversation_id: null, state: 'active', setup_error: null,
  setup_code: null, revision: 1, created_at: '', updated_at: '', removed_at: null, ...overrides,
})

const card = (overrides: Partial<TaskCard>): TaskCard => ({
  id: 'r1', project_id: 'project-1', title: 'Pruning', question: 'Does it hold?', stage: 'review',
  condition: 'none', condition_reason: null, revision: 1, approved_revision: 1, admitted_at: '',
  origin: 'conversation', authorizing_message_id: 'm1', participants: [], open_questions: 0,
  review_requested: true, updated_at: '', ...overrides,
})

function api(overrides: Record<string, unknown> = {}) {
  return {
    listProjects: vi.fn().mockResolvedValue([
      { id: 'project-1', name: 'Demo', path: '/demo' },
      { id: 'project-2', name: 'Other', path: '/other' },
    ]),
    listAgents: vi.fn().mockResolvedValue([]),
    listEntries: vi.fn().mockResolvedValue([]),
    listTerminals: vi.fn().mockResolvedValue([]),
    listConversations: vi.fn().mockResolvedValue([]),
    gitStatus: vi.fn().mockResolvedValue({ is_repository: false, branch: null, files: [] }),
    listResearch: vi.fn().mockResolvedValue([]),
    listChannels: vi.fn().mockResolvedValue([{
      id: 'c1', project_id: 'project-1', name: 'general', is_default: true, last_seq: 0, created_at: '',
    }]),
    listChannelMessages: vi.fn().mockResolvedValue({ messages: [], has_more: false }),
    listChannelThreads: vi.fn().mockResolvedValue([]),
    getChannelMessage: vi.fn().mockResolvedValue({
      id: 'm1', project_id: 'project-1', channel_id: 'c1', thread_id: null, seq: 1, kind: 'message',
      author_kind: 'researcher', author_ref: null, body: 'Prune the heads', intent: 'say', mentions: [],
      references: [], client_message_id: null, intent_claimed_by: null, created_at: '', task_id: 'r1',
      reply_to: null, hops: 0,
    }),
    listMembers: vi.fn().mockResolvedValue({
      members: [member({}), member({ id: 'm-analyst', role: 'specialist', name: 'Analyst', handle: 'analyst' })],
      general_id: 'm-general',
    }),
    taskBoard: vi.fn().mockResolvedValue({ cards: [card({})], stages: [], total: 1 }),
    taskDrafts: vi.fn().mockResolvedValue([]),
    openMemberDm: vi.fn(),
    searchProjectContext: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    memberDefaults: vi.fn().mockResolvedValue({ revision: 1, general: { agent_id: 'opencode', config: {}, instructions: '' }, templates: {} }),
    ...overrides,
  } as unknown as KubecodeApi
}

vi.mock('../research/ResearchWorkspace', () => ({
  ResearchWorkspace: ({ back, close, inspector, researchId }: {
    back?: { label: string; onBack: () => void }
    close?: { label: string; onClose: () => void }
    inspector?: React.ReactNode
    researchId: string
  }) => (
    <section aria-label={`task ${researchId}`}>
      {back && <button type="button" onClick={back.onBack}>{back.label}</button>}
      {close && <button type="button" onClick={close.onClose}>{close.label}</button>}
      {inspector}
    </section>
  ),
}))

vi.mock('../tasks/TaskInspector', () => ({
  TaskInspector: ({ onInspectEvidence }: { onInspectEvidence?: (target: { kind: string; id: string; revision?: string | null }) => void }) => (
    <div>
      <button type="button" onClick={() => onInspectEvidence?.({ kind: 'artifact', id: 'a1', revision: '3f' })}>
        Inspect artifact a1
      </button>
      <button type="button" onClick={() => onInspectEvidence?.({ kind: 'file', id: 'results.csv' })}>
        Inspect results.csv
      </button>
    </div>
  ),
}))

vi.mock('../work/EvidenceViewer', () => ({
  EvidenceViewer: ({ target }: { target: { kind: string; id: string } }) => (
    <section aria-label={`evidence ${target.kind}:${target.id}`} />
  ),
}))

const message = (overrides: Partial<ChannelMessage> = {}): ChannelMessage => ({
  id: 'm1', project_id: 'project-1', channel_id: 'c1', thread_id: null, seq: 1, kind: 'message',
  author_kind: 'researcher', author_ref: null, body: 'Prune the heads', intent: 'say', mentions: [],
  references: [], client_message_id: null, intent_claimed_by: null, created_at: '', task_id: 'r1',
  reply_to: null, hops: 0, ...overrides,
})

const thread = (overrides: Partial<ChannelThread> = {}): ChannelThread => ({
  id: 't1', project_id: 'project-1', channel_id: 'c1', root_message_id: 'm1', title: 'Pruning thread',
  research_id: null, round_id: null, revision: 1, reply_count: 0, last_seq: 1, created_by: null,
  created_at: '', updated_at: '', ...overrides,
})

const session = {
  id: 's1', project_id: 'project-1', agent_id: 'opencode', provider_session_id: 'p', title: 'Earlier chat',
  manual_title: null, agent_title: null,
}

/** Starts the app at `hash` (a Workspace link) and waits for the navigation. */
async function start(hash: string, client = api()) {
  window.history.replaceState(null, '', `/${hash}`)
  const view = render(<KubecodeApp api={client} />)
  const nav = await screen.findByRole('region', { name: 'Workspace' })
  return { ...view, client, nav }
}

function storeLocations(value: unknown) {
  localStorage.setItem('kubecode:workspace-location:v1', JSON.stringify(value))
}

function storedLocations(): { lastProjectId: string | null; workspaces: Record<string, unknown> } {
  window.dispatchEvent(new Event('pagehide'))
  return JSON.parse(localStorage.getItem('kubecode:workspace-location:v1') ?? '{"workspaces":{}}')
}

/** The open inspector (the top detail aside). */
function inspector(name: string | RegExp) {
  return screen.findByRole('complementary', { name })
}

/** The General composer (a combobox once members can be mentioned). */
function composer() {
  return screen.findByLabelText('Message the Workspace', { selector: 'textarea' })
}

function narrowScreen() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('max-width'),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }))
}

beforeEach(() => {
  localStorage.clear()
  // Most of these tests start on the Sessions surface; the address says so.
  window.history.replaceState(null, '', '/#/p/project-1/sessions')
})

afterEach(() => vi.unstubAllGlobals())

describe('Workspace navigation and routes', () => {
  it('opens General, the board, Resources, and Members from one navigation and names each in the URL hash', async () => {
    render(<KubecodeApp api={api()} />)
    const nav = await screen.findByRole('region', { name: 'Workspace' })
    expect(window.location.hash).toBe('#/p/project-1/sessions')

    fireEvent.click(within(nav).getAllByRole('button', { name: 'General' })[0])
    expect(await screen.findByRole('heading', { name: '# General' })).toBeInTheDocument()
    expect(window.location.hash).toBe('#/p/project-1/general')
    expect(within(nav).getAllByRole('button', { name: 'General' })[0]).toHaveAttribute('aria-current', 'page')

    fireEvent.click(within(nav).getByRole('button', { name: /^Kanban/ }))
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/board'))

    fireEvent.click(within(nav).getByRole('button', { name: 'Resources' }))
    expect(await screen.findByRole('heading', { name: 'Resources' })).toBeInTheDocument()
    expect(window.location.hash).toBe('#/p/project-1/resources')

    fireEvent.click(within(nav).getByRole('button', { name: 'Members' }))
    expect(await screen.findByRole('heading', { name: 'Members' })).toBeInTheDocument()
    expect(window.location.hash).toBe('#/p/project-1/members')
  })

  it('lands where a link points, under the base path, and keeps the path untouched', async () => {
    window.history.replaceState(null, '', '/user/alice/kubecode/#/p/project-1/resources')
    render(<KubecodeApp api={api()} />)
    expect(await screen.findByRole('heading', { name: 'Resources' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/user/alice/kubecode/')
    expect(window.location.hash).toBe('#/p/project-1/resources')
  })

  it('goes back to the earlier view with the browser Back button', async () => {
    render(<KubecodeApp api={api()} />)
    const nav = await screen.findByRole('region', { name: 'Workspace' })
    fireEvent.click(within(nav).getAllByRole('button', { name: 'General' })[0])
    await screen.findByRole('heading', { name: '# General' })
    fireEvent.click(within(nav).getByRole('button', { name: 'Resources' }))
    await screen.findByRole('heading', { name: 'Resources' })
    act(() => {
      window.history.replaceState(null, '', '#/p/project-1/general')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(await screen.findByRole('heading', { name: '# General' })).toBeInTheDocument()
  })

  it('gathers what waits for the researcher and opens the Task from it', async () => {
    render(<KubecodeApp api={api()} />)
    const nav = await screen.findByRole('region', { name: 'Workspace' })
    const waiting = await within(nav).findByRole('button', { name: /Pruning/ })
    expect(within(nav).getByText('Review')).toBeInTheDocument()
    fireEvent.click(waiting)
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/board?task=r1'))
  })

  it('keeps Files and Git out of the research views until asked for', async () => {
    render(<KubecodeApp api={api()} />)
    const nav = await screen.findByRole('region', { name: 'Workspace' })
    // The address is applied once the Workspace has loaded.
    await screen.findByTestId('agent-session-workspace')
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/sessions'))
    const toggle = screen.getByRole('button', { name: 'Toggle context panel' })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(within(nav).getAllByRole('button', { name: 'General' })[0])
    await screen.findByRole('heading', { name: '# General' })
    expect(screen.getByRole('button', { name: 'Toggle context panel' })).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'Toggle context panel' }))
    expect(screen.getByRole('button', { name: 'Toggle context panel' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('opens a private conversation from the roster', async () => {
    const analyst = member({ id: 'm-analyst', role: 'specialist', name: 'Analyst', handle: 'analyst', dm_conversation_id: 's-dm' })
    const client = api({
      openMemberDm: vi.fn().mockResolvedValue(analyst),
      memberDmTurns: vi.fn().mockResolvedValue([]),
    })
    render(<KubecodeApp api={client} />)
    const nav = await screen.findByRole('region', { name: 'Workspace' })
    fireEvent.click(await within(nav).findByRole('button', { name: 'Message Analyst privately' }))
    expect(await screen.findByRole('heading', { name: 'Private conversation with Analyst' })).toBeInTheDocument()
    expect(window.location.hash).toBe('#/p/project-1/dm/m-analyst')
    expect(client.openMemberDm).toHaveBeenCalledWith('project-1', 'm-analyst')
  })

  it('opens General for a Workspace with no Sessions, and a link still decides first', async () => {
    window.history.replaceState(null, '', '/')
    const first = render(<KubecodeApp api={api()} />)
    expect(await screen.findByRole('heading', { name: '# General' })).toBeInTheDocument()
    expect(window.location.hash).toBe('#/p/project-1/general')
    first.unmount()

    window.history.replaceState(null, '', '/#/p/project-1/resources')
    render(<KubecodeApp api={api()} />)
    expect(await screen.findByRole('heading', { name: 'Resources', level: 2 })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '# General' })).not.toBeInTheDocument()
  })

  it('opens General for a Workspace with Sessions but no remembered place, and never renders a Session', async () => {
    window.history.replaceState(null, '', '/')
    const sessions: Element[] = []
    const observer = new MutationObserver(() => {
      const found = document.querySelector('[data-testid="agent-session-workspace"]')
      if (found) sessions.push(found)
    })
    observer.observe(document.body, { childList: true, subtree: true })
    render(<KubecodeApp api={api({ listConversations: vi.fn().mockResolvedValue([session]) })} />)
    expect(await screen.findByRole('heading', { name: '# General' })).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/general'))
    observer.disconnect()
    expect(sessions).toEqual([])
  })

  it('restores each Workspace to its own place', async () => {
    await start('#/p/project-1/board?task=r1')
    expect(await inspector('Task details')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Other' }))
    expect(await screen.findByRole('heading', { name: '# General' })).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-2/general'))
    expect(screen.getByText('Other: General')).toHaveAttribute('role', 'status')

    fireEvent.click(screen.getByRole('button', { name: 'Demo' }))
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/board?task=r1'))
    expect(await inspector('Task details')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'task r1' })).toBeInTheDocument()
  })

  it('reopens the last Workspace at its remembered place when there is no link', async () => {
    storeLocations({
      lastProjectId: 'project-2',
      seq: 2,
      workspaces: { 'project-2': { current: 'resources', at: 2, views: { resources: '/p/project-2/resources' } } },
    })
    window.history.replaceState(null, '', '/')
    render(<KubecodeApp api={api()} />)
    expect(await screen.findByRole('heading', { name: 'Resources', level: 2 })).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-2/resources'))
  })

  it('goes from General to a Task to its evidence and back, and closing lands on the message with the draft intact', async () => {
    await start('#/p/project-1/general?filter=r1', api({
      listChannelMessages: vi.fn().mockResolvedValue({ messages: [message()], has_more: false }),
    }))
    const box = await composer()
    fireEvent.change(box, { target: { value: 'Half a thought' } })

    fireEvent.click(await screen.findByRole('button', { name: 'Task: r1' }))
    expect(await inspector('Task details')).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/general/m/m1?task=r1&filter=r1'))

    const evidenceButton = screen.getByRole('button', { name: 'Inspect artifact a1' })
    evidenceButton.focus()
    fireEvent.click(evidenceButton)
    expect(await inspector('Evidence details')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'evidence artifact:a1' })).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe(
      '#/p/project-1/general/m/m1?task=r1&filter=r1&inspect=evidence~artifact~a1~3f',
    ))

    fireEvent.click(screen.getByRole('button', { name: 'Back to Task details' }))
    expect(await inspector('Task details')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Inspect artifact a1' })).toHaveFocus())
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/general/m/m1?task=r1&filter=r1'))

    fireEvent.click(screen.getByRole('button', { name: 'Close details' }))
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/general/m/m1?filter=r1'))
    expect(screen.queryByRole('complementary', { name: 'Task details' })).not.toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toHaveAttribute('data-message-id', 'm1'))
    expect(await composer()).toHaveValue('Half a thought')
  })

  it('opens file evidence over the Task without writing its path into the address', async () => {
    await start('#/p/project-1/general?task=r1')
    expect(await inspector('Task details')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Inspect results.csv' }))
    expect(await inspector('Evidence details')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'evidence file:results.csv' })).toBeInTheDocument()
    expect(window.location.hash).toBe('#/p/project-1/general?task=r1')
  })

  it('returns to General with its message, filter, and open Task after a visit to Kanban', async () => {
    const { nav } = await start('#/p/project-1/general/m/m1?task=r1&filter=r1')
    expect(await inspector('Task details')).toBeInTheDocument()
    fireEvent.click(within(nav).getByRole('button', { name: /^Kanban/ }))
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/board'))
    fireEvent.click(within(nav).getAllByRole('button', { name: 'General' })[0])
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/general/m/m1?task=r1&filter=r1'))
    expect(await inspector('Task details')).toBeInTheDocument()
  })

  it('keeps the view and its draft under a full-screen inspector on a phone', async () => {
    narrowScreen()
    await start('#/p/project-1/general', api({
      listChannelMessages: vi.fn().mockResolvedValue({ messages: [message()], has_more: false }),
    }))
    const box = await composer()
    fireEvent.change(box, { target: { value: 'Half a thought' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Task: r1' }))
    expect(await inspector('Task details')).toBeInTheDocument()
    expect(document.querySelector('.kubecode-session-context-row')).toHaveAttribute('data-inspector-layout', 'screen')
    expect(screen.queryByRole('button', { name: 'Close details' })).not.toBeInTheDocument()
    // The conversation is parked under the inspector, not removed.
    expect(box).toBeInTheDocument()
    expect(document.querySelector('[data-message-id="m1"]')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Back to General' }))
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Task details' })).not.toBeInTheDocument())
    expect(await composer()).toBe(box)
    expect(box).toHaveValue('Half a thought')
  })

  it('offers no way "back" from any primary view', async () => {
    const analyst = member({ id: 'm-analyst', role: 'specialist', name: 'Analyst', handle: 'analyst', dm_conversation_id: 's-dm' })
    const { nav } = await start('#/p/project-1/general', api({
      openMemberDm: vi.fn().mockResolvedValue(analyst),
      memberDmTurns: vi.fn().mockResolvedValue([]),
    }))
    const noBack = () => expect(screen.queryAllByRole('button', { name: /^Back( to Sessions)?$/ })).toEqual([])
    await screen.findByRole('heading', { name: '# General' })
    noBack()
    fireEvent.click(within(nav).getByRole('button', { name: /^Kanban/ }))
    await screen.findByRole('heading', { name: 'Kanban', level: 2 })
    noBack()
    fireEvent.click(within(nav).getByRole('button', { name: 'Resources' }))
    await screen.findByRole('heading', { name: 'Resources', level: 2 })
    noBack()
    fireEvent.click(within(nav).getByRole('button', { name: 'Members' }))
    await screen.findByRole('heading', { name: 'Members', level: 2 })
    noBack()
    fireEvent.click(await within(nav).findByRole('button', { name: 'Message Analyst privately' }))
    await screen.findByRole('heading', { name: 'Private conversation with Analyst' })
    noBack()
  })

  it('reaches a Session from execution history, and General still returns to its place', async () => {
    const { nav } = await start('#/p/project-1/general/m/m1', api({
      listConversations: vi.fn().mockResolvedValue([session]),
    }))
    await screen.findByRole('heading', { name: '# General' })
    const expand = screen.queryByRole('button', { name: 'Expand project' })
    if (expand) fireEvent.click(expand)
    fireEvent.click(await screen.findByRole('button', { name: /^Earlier chat/ }))
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/sessions/c/s1'))
    expect(screen.getByTestId('agent-session-workspace')).toBeInTheDocument()

    fireEvent.click(within(nav).getAllByRole('button', { name: 'General' })[0])
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/general/m/m1'))
  })

  it('leaves a history entry for the move after execution history fills in its Session', async () => {
    const { nav } = await start('#/p/project-1/sessions', api({
      listConversations: vi.fn().mockResolvedValue([session]),
    }))
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/sessions/c/s1'))
    const before = window.history.length
    fireEvent.click(within(nav).getAllByRole('button', { name: 'General' })[0])
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/general'))
    expect(window.history.length).toBe(before + 1)
  })

  it.each([
    ['#/p/project-1/sessions/c/s1', () => screen.findByTestId('agent-session-workspace')],
    ['#/p/project-1/general?thread=t1', () => screen.findByRole('complementary', { name: 'Thread' })],
    ['#/p/project-1/members?member=m-analyst', () => screen.findByRole('complementary', { name: 'Analyst' })],
    ['#/p/project-1/question/r1', () => screen.findByRole('region', { name: 'task r1' })],
    ['#/p/project-1/general?task=r1&thread=t1', () => screen.findByRole('complementary', { name: 'Task details' })],
  ])('still opens the place an older link names: %s', async (hash, shown) => {
    await start(hash, api({
      listConversations: vi.fn().mockResolvedValue([session]),
      listChannelMessages: vi.fn().mockResolvedValue({ messages: [message()], has_more: false }),
      listChannelThreads: vi.fn().mockResolvedValue([thread()]),
    }))
    expect(await shown()).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe(hash))
  })

  it('reopens the Session execution history was left on, once the Sessions are read', async () => {
    const later = { ...session, id: 's2', title: 'Later chat' }
    storeLocations({
      lastProjectId: 'project-1',
      seq: 1,
      workspaces: { 'project-1': { current: 'sessions', at: 1, views: { sessions: '/p/project-1/sessions/c/s1' } } },
    })
    window.history.replaceState(null, '', '/')
    render(<KubecodeApp api={api({ listConversations: vi.fn().mockResolvedValue([session, later]) })} />)
    expect(await screen.findByTestId('agent-session-workspace')).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/sessions/c/s1'))
  })

  it('opens General when the remembered Session is no longer one of this Workspace', async () => {
    storeLocations({
      lastProjectId: 'project-1',
      seq: 1,
      workspaces: { 'project-1': { current: 'sessions', at: 1, views: { sessions: '/p/project-1/sessions/c/gone' } } },
    })
    window.history.replaceState(null, '', '/')
    render(<KubecodeApp api={api({ listConversations: vi.fn().mockResolvedValue([session]) })} />)
    expect(await screen.findByRole('heading', { name: '# General' })).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/general'))
  })

  it('falls back to General when a private conversation cannot be opened', async () => {
    await start('#/p/project-1/dm/m-analyst', api({ openMemberDm: vi.fn().mockRejectedValue(new Error('gone')) }))
    expect(await screen.findByRole('heading', { name: '# General' })).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/general'))
  })

  it('restores the remembered place, never Sessions, from a damaged link', async () => {
    storeLocations({
      lastProjectId: 'project-1',
      seq: 1,
      workspaces: { 'project-1': { current: 'resources', at: 1, views: { resources: '/p/project-1/resources' } } },
    })
    await start('#/p/project-1/nowhere', api({ listConversations: vi.fn().mockResolvedValue([session]) }))
    expect(await screen.findByRole('heading', { name: 'Resources', level: 2 })).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/resources'))
  })

  it('forgets the places of a Workspace that is removed', async () => {
    storeLocations({
      lastProjectId: 'project-1',
      seq: 2,
      workspaces: {
        'project-1': { current: 'board', at: 1, views: { board: '/p/project-1/board' } },
        'project-2': { current: 'members', at: 2, views: { members: '/p/project-2/members' } },
      },
    })
    await start('#/p/project-1/board', api({ unregisterProject: vi.fn().mockResolvedValue(undefined) }))
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Actions for project Demo' }), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    })
    fireEvent.click(await screen.findByText('Delete'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Demo' })).not.toBeInTheDocument())
    await waitFor(() => expect(Object.keys(storedLocations().workspaces)).toEqual(['project-2']))
  })

  it('abandons a link to a Project that is not registered at once', async () => {
    window.history.replaceState(null, '', '/#/p/project-9/board')
    render(<KubecodeApp api={api()} />)
    // Well within the time a link is otherwise waited for.
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/general'), { timeout: 1_000 })
    expect(await screen.findByRole('heading', { name: '# General' })).toBeInTheDocument()
  })

  it('keeps what is open when the current destination is chosen again', async () => {
    const { nav } = await start('#/p/project-1/board?task=r1')
    expect(await inspector('Task details')).toBeInTheDocument()
    fireEvent.click(within(nav).getByRole('button', { name: /^Kanban/ }))
    expect(screen.getByRole('complementary', { name: 'Task details' })).toBeInTheDocument()
    expect(window.location.hash).toBe('#/p/project-1/board?task=r1')
  })
})
