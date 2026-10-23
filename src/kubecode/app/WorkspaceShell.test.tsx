import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { KubecodeApp } from '../App'

import type { ChannelMessage, ChannelThread, KubecodeApi, Member, TaskCard } from '../api'
import { permissionItem, reviewItem, setupItem, snapshot } from '../attention/attentionFixtures'

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
    attention: vi.fn().mockResolvedValue(snapshot({
      project_id: 'project-1',
      items: [reviewItem({ project_id: 'project-1', task: { id: 'r1', title: 'Pruning' } })],
    })),
    openMemberDm: vi.fn(),
    searchProjectContext: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    memberDefaults: vi.fn().mockResolvedValue({ revision: 1, general: { agent_id: 'opencode', config: {}, instructions: '' }, templates: {} }),
    ...overrides,
  } as unknown as KubecodeApi
}

vi.mock('../research/ResearchWorkspace', () => ({
  ResearchWorkspace: ({ onOpenTask, onOpenThread, researchId }: {
    onOpenThread?: (threadId: string) => void
    onOpenTask?: () => void
    researchId: string
  }) => (
    <section aria-label={`task ${researchId}`}>
      {onOpenThread && <button type="button" onClick={() => onOpenThread('t1')}>Open thread t1</button>}
      {/* The real view offers this only when the research record says it is a Task. */}
      {onOpenTask && <button type="button" onClick={onOpenTask}>Open the Task</button>}
    </section>
  ),
}))

vi.mock('../tasks/TaskPanel', async () => {
  const { InspectorPanel } = await import('./inspector/InspectorPanel')
  const { useInspectorEntry, useInspectorServices } = await import('./inspector/inspectorContext')
  const { useWorkspaceNavigation } = await import('./location/WorkspaceNavigation')
  const { useGeneralFromTask } = await import('../tasks/taskNavigation')
  return {
    TaskPanel: ({ entry }: { entry: { id: string } }) => {
      const { push } = useInspectorEntry()
      const { t } = useInspectorServices()
      const { openPlace } = useWorkspaceNavigation()
      const general = useGeneralFromTask()
      return (
        <InspectorPanel title={t('kubecode.nav.taskDetail')}>
          <section aria-label={`task ${entry.id}`}>
            <button type="button" onClick={() => general({ message: 'm1' })}>Show message m1</button>
            <button
              type="button"
              onClick={() => push({ kind: 'evidence', ref: { kind: 'artifact', id: 'a1', revision: '3f' } }, { from: 'evidence:artifact:a1' })}
            >
              Inspect artifact a1
            </button>
            <button type="button" onClick={() => push({ kind: 'evidence', ref: { kind: 'file', id: 'results.csv', revision: null } })}>
              Inspect results.csv
            </button>
            <button
              type="button"
              onClick={() => openPlace({ view: 'general', thread: 't1', filter: null }, { inspector: 'closed' })}
            >
              Open thread t1
            </button>
          </section>
        </InspectorPanel>
      )
    },
  }
})

// The record reader is covered by its own tests; here it only names what it shows.
vi.mock('../resources/RecordPreview', () => ({
  RecordPreview: ({ target }: { target: { kind: string; id: string } }) => (
    <section aria-label={`evidence ${target.kind}:${target.id}`} />
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

const contextItem = (kind: string, id: string, title: string) => ({
  ref: { kind, id, revision: null },
  title,
  summary: '',
  provenance: { state: null, author: null, updated_at: null },
  availability: 'available',
})

const contextDocument = (kind: string, id: string, title: string) => ({
  ref: { kind, id, revision: null }, detail: 'content', title, availability: 'available', provenance: {},
  sections: [], related: [], next_cursor: null, notes: [],
})

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
    expect(await screen.findByRole('heading', { name: 'General', exact: true, level: 2 })).toBeInTheDocument()
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

  it('titles all five destinations with the same header, and none of them offers Back', async () => {
    render(<KubecodeApp api={api()} />)
    const nav = await screen.findByRole('region', { name: 'Workspace' })
    for (const [name, destination] of [
      ['General', 'general'], [/^Kanban/, 'board'], ['Resources', 'resources'], [/^Needs you/, 'needs-you'], ['Members', 'members'],
    ] as const) {
      fireEvent.click(within(nav).getAllByRole('button', { name })[0])
      await waitFor(() => expect(window.location.hash).toBe(`#/p/project-1/${destination}`))
      const header = await waitFor(() => {
        const found = document.querySelector(`.kubecode-session-context-row header.kubecode-destination-header[data-destination="${destination}"]`)
        expect(found).not.toBeNull()
        return found as HTMLElement
      })
      expect(within(header).getByRole('heading', { level: 2 })).toBeInTheDocument()
      expect(within(header).queryByRole('button', { name: /^Back/ })).not.toBeInTheDocument()
    }
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
    await screen.findByRole('heading', { name: 'General', exact: true, level: 2 })
    fireEvent.click(within(nav).getByRole('button', { name: 'Resources' }))
    await screen.findByRole('heading', { name: 'Resources' })
    act(() => {
      window.history.replaceState(null, '', '#/p/project-1/general')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(await screen.findByRole('heading', { name: 'General', exact: true, level: 2 })).toBeInTheDocument()
  })

  it('gathers what waits for the researcher in Needs you, a place of its own, and opens the Task from it', async () => {
    render(<KubecodeApp api={api()} />)
    const nav = await screen.findByRole('region', { name: 'Workspace' })
    fireEvent.click(await within(nav).findByRole('button', { name: /^Needs you/ }))
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/needs-you'))
    const view = await screen.findByRole('region', { name: 'Needs you' })
    expect(within(view).getByRole('heading', { level: 2, name: 'Needs you' })).toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: /^Needs you/ })).toHaveAttribute('aria-current', 'page')
    const waiting = await within(view).findByRole('button', { name: /Pruning/ })
    expect(within(view).getByText('Review')).toBeInTheDocument()
    fireEvent.click(waiting)
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/board?task=r1'))
  })

  it('opens a member’s permission request in the member’s private conversation', async () => {
    const client = api({
      attention: vi.fn().mockResolvedValue(snapshot({
        project_id: 'project-1',
        items: [permissionItem({ project_id: 'project-1', binding: 'dm', member: { id: 'm-analyst', name: 'Analyst', handle: 'analyst', role: 'specialist' } })],
      })),
      listMembers: vi.fn().mockResolvedValue({
        members: [member({}), member({ id: 'm-analyst', role: 'specialist', name: 'Analyst', handle: 'analyst', dm_conversation_id: 'dm1' })],
        general_id: 'm-general',
      }),
      memberDmTurns: vi.fn().mockResolvedValue([]),
    })
    window.history.replaceState(null, '', '/#/p/project-1/needs-you')
    render(<KubecodeApp api={client} />)
    const view = await screen.findByRole('region', { name: 'Needs you' })
    fireEvent.click(await within(view).findByRole('button', { name: /Analyst wants to use Run pytest -q/ }))
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/dm/m-analyst'))
  })

  it('announces what newly needs the researcher in the shell\'s status region, with the navigation sheet closed', async () => {
    narrowScreen()
    const { nav } = await start('#/p/project-1/general')
    const shellStatus = () => document.querySelector('main.kubecode-app > [role="status"]')
    await waitFor(() => expect(shellStatus()).toHaveTextContent('Review the results of Pruning needs you'))
    // The navigation only counts what waits: the list is the Needs you view, never folded into the sheet.
    expect(nav.querySelector('.kubecode-needs-you-list')).toBeNull()
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
    await screen.findByRole('heading', { name: 'General', exact: true, level: 2 })
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

  it('lands a Workspace whose manager needs setup in General with a recovery that opens the manager in Members', async () => {
    window.history.replaceState(null, '', '/#/p/project-1/general')
    const broken = member({ state: 'setup_required', setup_code: 'provider_unavailable' })
    const client = api({
      listMembers: vi.fn().mockResolvedValue({ members: [broken], general_id: 'm-general' }),
      retryMemberSetup: vi.fn().mockResolvedValue(broken),
    })
    render(<KubecodeApp api={client} />)
    const notice = (await screen.findByText('The project manager is not ready')).closest('[role="alert"]') as HTMLElement
    expect(notice).toHaveTextContent('OpenCode is not installed or available on this server.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry setup' }))
    await waitFor(() => expect(client.retryMemberSetup).toHaveBeenCalledWith('project-1', 'm-general'))
    fireEvent.click(screen.getByRole('button', { name: 'Open Members' }))
    expect(await screen.findByRole('heading', { name: 'Members', level: 2 })).toBeInTheDocument()
    expect(await screen.findByRole('complementary', { name: 'General' })).toBeInTheDocument()
  })

  it('reads the roster again when a manager\'s setup fails after it was read', async () => {
    window.history.replaceState(null, '', '/#/p/project-1/general')
    const listMembers = vi.fn()
      .mockResolvedValueOnce({ members: [member({})], general_id: 'm-general' })
      .mockResolvedValue({ members: [member({ state: 'setup_required', setup_code: 'provider_unavailable' })], general_id: 'm-general' })
    render(<KubecodeApp api={api({
      listMembers,
      attention: vi.fn().mockResolvedValue(snapshot({
        project_id: 'project-1',
        items: [setupItem({ project_id: 'project-1', member_id: 'm-general', setup_code: 'provider_unavailable' })],
      })),
    })} />)
    expect(await screen.findByText('The project manager is not ready')).toBeInTheDocument()
    expect(listMembers.mock.calls.length).toBeGreaterThan(1)
  })

  it('opens General for a Workspace with no Sessions, and a link still decides first', async () => {
    window.history.replaceState(null, '', '/')
    const first = render(<KubecodeApp api={api()} />)
    expect(await screen.findByRole('heading', { name: 'General', exact: true, level: 2 })).toBeInTheDocument()
    expect(window.location.hash).toBe('#/p/project-1/general')
    first.unmount()

    window.history.replaceState(null, '', '/#/p/project-1/resources')
    render(<KubecodeApp api={api()} />)
    expect(await screen.findByRole('heading', { name: 'Resources', level: 2 })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'General', exact: true, level: 2 })).not.toBeInTheDocument()
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
    expect(await screen.findByRole('heading', { name: 'General', exact: true, level: 2 })).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/general'))
    observer.disconnect()
    expect(sessions).toEqual([])
  })

  it('restores each Workspace to its own place', async () => {
    await start('#/p/project-1/board?task=r1')
    expect(await inspector('Task details')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Other' }))
    expect(await screen.findByRole('heading', { name: 'General', exact: true, level: 2 })).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-2/general'))
    expect(screen.getByText('Other: General').closest('[role="status"]')).toBe(document.querySelector('main.kubecode-app > [role="status"]'))

    fireEvent.click(screen.getByRole('button', { name: 'Demo' }))
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/board?task=r1'))
    expect(await inspector('Task details')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'task r1' })).toBeInTheDocument()
  })

  it('opens a Workspace registered elsewhere since load when a link names it, and abandons an unknown one', async () => {
    window.history.replaceState(null, '', '/#/p/project-1/general')
    const known = [{ id: 'project-1', name: 'Demo', path: '/demo' }]
    const listProjects = vi.fn().mockResolvedValue(known)
    render(<KubecodeApp api={api({ listProjects })} />)
    expect(await screen.findByRole('heading', { name: 'General', exact: true, level: 2 })).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/general'))

    // Registered through the API after the page read its Workspaces.
    listProjects.mockResolvedValue([...known, { id: 'project-3', name: 'Fresh', path: '/fresh' }])
    act(() => {
      window.history.pushState(null, '', '/#/p/project-3/resources')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(await screen.findByRole('heading', { name: 'Resources', level: 2 })).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-3/resources'))
    expect(screen.getByRole('button', { name: 'Fresh' })).toBeInTheDocument()

    act(() => {
      window.history.pushState(null, '', '/#/p/project-unknown/general')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-3/resources'))
  })

  it('opens the linked Workspace on a reload, over the remembered one', async () => {
    storeLocations({
      lastProjectId: 'project-1',
      seq: 2,
      workspaces: { 'project-1': { current: 'board', at: 2, views: { board: '/p/project-1/board' } } },
    })
    window.history.replaceState(null, '', '/#/p/project-2/general')
    render(<KubecodeApp api={api()} />)
    expect(await screen.findByRole('heading', { name: 'General', exact: true, level: 2 })).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-2/general'))
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

    // Filtered to the Task, its chip is not repeated under the message; More actions opens it.
    fireEvent.pointerDown(await screen.findByRole('button', { name: /More actions for .*message/ }), { button: 0, ctrlKey: false, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open the Task' }))
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
    fireEvent.click(await screen.findByRole('button', { name: 'Task Task (no title)' }))
    expect(await inspector('Task details')).toBeInTheDocument()
    expect(document.querySelector('.kubecode-session-context-row')).toHaveAttribute('data-inspector-layout', 'screen')
    expect(screen.queryByRole('button', { name: 'Close details' })).not.toBeInTheDocument()
    // The conversation is parked under the inspector, not removed.
    expect(box).toBeInTheDocument()
    expect(document.querySelector('[data-message-id="m1"]')).toBeInTheDocument()

    // Parked: still there, but out of reach until the inspector is gone.
    expect(document.querySelector('.kubecode-channel-main')).toHaveAttribute('inert')

    fireEvent.click(screen.getByRole('button', { name: 'Back to General' }))
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Task details' })).not.toBeInTheDocument())
    expect(await composer()).toBe(box)
    expect(box).toHaveValue('Half a thought')
    expect(document.querySelector('.kubecode-channel-main')).not.toHaveAttribute('inert')
  })

  it('parks the board under a full-screen Task on a phone', async () => {
    narrowScreen()
    await start('#/p/project-1/board?task=r1')
    expect(await inspector('Task details')).toBeInTheDocument()
    expect(document.querySelector('.kubecode-inspector-main')).toHaveAttribute('inert')
    expect(screen.getByTestId('task-card-r1')).toBeInTheDocument()
  })

  it('offers no way "back" from any primary view', async () => {
    const analyst = member({ id: 'm-analyst', role: 'specialist', name: 'Analyst', handle: 'analyst', dm_conversation_id: 's-dm' })
    const { nav } = await start('#/p/project-1/general', api({
      openMemberDm: vi.fn().mockResolvedValue(analyst),
      memberDmTurns: vi.fn().mockResolvedValue([]),
    }))
    // No "Back", "Back to Sessions", or any other way back to Sessions, anywhere in the main pane.
    const noBack = () => {
      expect(screen.queryAllByRole('button', { name: /back to sessions|^back$/i })).toEqual([])
      const main = document.querySelector('.kubecode-session-context-row') as HTMLElement
      for (const role of ['button', 'link']) {
        // A filter toggle (Resources' "Sessions" kind) is not a way anywhere.
        const ways = within(main).queryAllByRole(role, { name: /^back\b|sessions/i })
          .filter((control) => !control.hasAttribute('aria-pressed'))
        expect(ways).toEqual([])
      }
    }
    await screen.findByRole('heading', { name: 'General', exact: true, level: 2 })
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
    await screen.findByRole('heading', { name: 'General', exact: true, level: 2 })
    fireEvent.click(await screen.findByRole('button', { name: /^Earlier chat/ }))
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/sessions/c/s1'))
    expect(await screen.findByTestId('agent-session-workspace')).toBeInTheDocument()

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
    ['#/p/project-1/general?thread=t1', () => screen.findByRole('complementary', { name: 'Earlier thread' })],
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

  it('opens a legacy question\'s Task on Kanban, whatever the board lists', async () => {
    await start('#/p/project-1/question/r1')
    fireEvent.click(await screen.findByRole('button', { name: 'Open the Task' }))
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/board?task=r1'))
    expect(await inspector('Task details')).toBeInTheDocument()
  })

  it('offers an archived Task\'s question the way to it even when the board lists no such Task', async () => {
    const board = { cards: [], stages: [], total: 0, archived: [] }
    await start('#/p/project-1/question/r2', api({ taskBoard: vi.fn().mockResolvedValue(board) }))
    fireEvent.click(await screen.findByRole('button', { name: 'Open the Task' }))
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/board?task=r2'))
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

  it('goes to General, never to another Session, when the Session on screen is removed', async () => {
    const later = { ...session, id: 's2', title: 'Later chat' }
    await start('#/p/project-1/sessions/c/s1', api({
      listConversations: vi.fn().mockResolvedValue([session, later]),
      deleteConversation: vi.fn().mockResolvedValue(undefined),
    }))
    await screen.findByTestId('agent-session-workspace')
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/sessions/c/s1'))
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Actions for Earlier chat' }), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))
    expect(await screen.findByRole('heading', { name: 'General', exact: true, level: 2 })).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/general'))
    expect(screen.queryByTestId('agent-session-workspace')).not.toBeInTheDocument()
    expect(JSON.stringify(storedLocations().workspaces['project-1'])).not.toContain('s2')
  })

  it('keeps the remembered Session when the Sessions cannot be read', async () => {
    storeLocations({
      lastProjectId: 'project-1',
      seq: 1,
      workspaces: { 'project-1': { current: 'sessions', at: 1, views: { sessions: '/p/project-1/sessions/c/s1' } } },
    })
    window.history.replaceState(null, '', '/')
    render(<KubecodeApp api={api({ listConversations: vi.fn().mockRejectedValue(new Error('offline')) })} />)
    await waitFor(() => expect(screen.getByRole('status', { name: 'offline' })).toHaveAttribute('data-variant', 'destructive'))
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(storedLocations().workspaces['project-1']).toMatchObject({
      current: 'sessions',
      views: { sessions: '/p/project-1/sessions/c/s1' },
    })
  })

  it('opens General when the remembered Session is no longer one of this Workspace', async () => {
    storeLocations({
      lastProjectId: 'project-1',
      seq: 1,
      workspaces: { 'project-1': { current: 'sessions', at: 1, views: { sessions: '/p/project-1/sessions/c/gone' } } },
    })
    window.history.replaceState(null, '', '/')
    render(<KubecodeApp api={api({ listConversations: vi.fn().mockResolvedValue([session]) })} />)
    expect(await screen.findByRole('heading', { name: 'General', exact: true, level: 2 })).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/general'))
  })

  it('falls back to General when a private conversation cannot be opened', async () => {
    await start('#/p/project-1/dm/m-analyst', api({ openMemberDm: vi.fn().mockRejectedValue(new Error('gone')) }))
    expect(await screen.findByRole('heading', { name: 'General', exact: true, level: 2 })).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/general'))
  })

  it('opens a private conversation from a link even when the roster cannot be read', async () => {
    const analyst = member({ id: 'm-analyst', role: 'specialist', name: 'Analyst', handle: 'analyst', dm_conversation_id: 's-dm' })
    await start('#/p/project-1/dm/m-analyst', api({
      listMembers: vi.fn().mockRejectedValue(new Error('roster down')),
      openMemberDm: vi.fn().mockResolvedValue(analyst),
      memberDmTurns: vi.fn().mockResolvedValue([]),
    }))
    expect(await screen.findByRole('heading', { name: 'Private conversation with Analyst' })).toBeInTheDocument()
    expect(window.location.hash).toBe('#/p/project-1/dm/m-analyst')
  })

  it('falls back to General with the error shown when neither the roster nor the conversation can be read', async () => {
    await start('#/p/project-1/dm/m-analyst', api({
      listMembers: vi.fn().mockRejectedValue(new Error('roster down')),
      openMemberDm: vi.fn().mockRejectedValue(new Error('gone')),
    }))
    expect(await screen.findByRole('heading', { name: 'General', exact: true, level: 2 })).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/general'))
    expect(screen.queryByText('Opening Workspace…')).not.toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'gone' })).toHaveAttribute('data-variant', 'destructive')
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

  it('reaches a link without a Project in the active Workspace at once, with no extra history entry', async () => {
    window.history.replaceState(null, '', '/#/resources')
    const before = window.history.length
    render(<KubecodeApp api={api()} />)
    // Well within the time a link is otherwise waited for.
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/resources'), { timeout: 1_000 })
    expect(await screen.findByRole('heading', { name: 'Resources', level: 2 })).toBeInTheDocument()
    expect(window.history.length).toBe(before)
  })

  it('stays in the Workspace on screen when another one is removed', async () => {
    await start('#/p/project-3/members', api({
      listProjects: vi.fn().mockResolvedValue([
        { id: 'project-1', name: 'Demo', path: '/demo' },
        { id: 'project-2', name: 'Other', path: '/other' },
        { id: 'project-3', name: 'Third', path: '/third' },
      ]),
      unregisterProject: vi.fn().mockResolvedValue(undefined),
    }))
    await screen.findByRole('heading', { name: 'Members', level: 2 })
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Actions for project Demo' }), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    })
    fireEvent.click(await screen.findByText('Delete'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Demo' })).not.toBeInTheDocument())
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-3/members'))
    expect(screen.getByRole('button', { name: 'Third' })).toHaveAttribute('aria-current', 'true')
  })

  it('opens the next Workspace as at startup when the one on screen is removed', async () => {
    storeLocations({
      lastProjectId: 'project-1',
      seq: 2,
      workspaces: { 'project-2': { current: 'resources', at: 2, views: { resources: '/p/project-2/resources' } } },
    })
    await start('#/p/project-1/board', api({ unregisterProject: vi.fn().mockResolvedValue(undefined) }))
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Actions for project Demo' }), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    })
    fireEvent.click(await screen.findByText('Delete'))
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-2/resources'))
  })

  it('abandons a link to a Project that is not registered at once', async () => {
    window.history.replaceState(null, '', '/#/p/project-9/board')
    render(<KubecodeApp api={api()} />)
    // Well within the time a link is otherwise waited for.
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/general'), { timeout: 1_000 })
    expect(await screen.findByRole('heading', { name: 'General', exact: true, level: 2 })).toBeInTheDocument()
  })

  it('opens a finding cited in General in the inspector beside the conversation', async () => {
    await start('#/p/project-1/general', api({
      listChannelMessages: vi.fn().mockResolvedValue({
        messages: [message({ references: [{ kind: 'finding', id: 'f1', revision: null }] })],
        has_more: false,
      }),
    }))
    const references = await screen.findByRole('list', { name: 'References' })
    fireEvent.click(within(references).getByRole('button', { name: /Finding/ }))
    expect(await inspector('Resource details')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'evidence finding:f1' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'General', exact: true, level: 2 })).toBeInTheDocument()
    expect(document.querySelector('.kubecode-session-context-row')).toHaveAttribute('data-inspector-layout', 'side')
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/general?inspect=resource~finding~f1'))
  })

  it.each([
    ['finding', 'f1', 'Accuracy holds', 'Resource details', 'evidence finding:f1'],
    ['artifact', 'a7', 'accuracy.csv', 'Resource details', 'evidence artifact:a7'],
    ['research', 'r1', 'Pruning', 'Task details', 'task r1'],
  ])('opens a Resources row (%s) in Resources’ own inspector beside the list, never leaving it', async (kind, id, title, aside, body) => {
    await start('#/p/project-1/resources', api({
      searchProjectContext: vi.fn().mockResolvedValue({ items: [contextItem(kind, id, title)], next_cursor: null }),
      readProjectContext: vi.fn().mockResolvedValue(contextDocument(kind, id, title)),
    }))
    fireEvent.click(await screen.findByRole('option', { name: new RegExp(title) }))
    expect(await inspector(aside)).toBeInTheDocument()
    expect(screen.getByRole('region', { name: body })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Resources', level: 2 })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: new RegExp(title) })).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/p\/project-1\/resources\?/))
    // A routable record is named by kind and id only; the words searched never are.
    if (kind !== 'research') expect(window.location.hash).toContain(`inspect=resource~${kind}~${id}`)
  })

  it('keeps the Resources search, sections, and preview after a visit to Kanban', async () => {
    const search = vi.fn().mockResolvedValue({ items: [contextItem('finding', 'f1', 'Accuracy holds')], next_cursor: null })
    const { nav } = await start('#/p/project-1/resources', api({
      searchProjectContext: search,
      readProjectContext: vi.fn().mockResolvedValue(contextDocument('finding', 'f1', 'Accuracy holds')),
    }))
    fireEvent.change(await screen.findByRole('combobox', { name: 'Search Demo' }), { target: { value: 'accuracy' } })
    fireEvent.click(screen.getByRole('button', { name: /^Files/ }))
    fireEvent.click(await screen.findByRole('option', { name: /Accuracy holds/ }))
    expect(await screen.findByRole('region', { name: 'evidence finding:f1' })).toBeInTheDocument()

    fireEvent.click(within(nav).getByRole('button', { name: /^Kanban/ }))
    await screen.findByRole('heading', { name: 'Kanban', level: 2 })
    fireEvent.click(within(nav).getByRole('button', { name: 'Resources' }))
    await screen.findByRole('heading', { name: 'Resources', level: 2 })
    expect(screen.getByRole('combobox', { name: 'Search Demo' })).toHaveValue('accuracy')
    expect(screen.getByRole('button', { name: /^Files/ })).toHaveAttribute('aria-pressed', 'false')
    expect(await screen.findByRole('option', { name: /Accuracy holds/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('region', { name: 'evidence finding:f1' })).toBeInTheDocument()
    // The words searched never reach the address.
    expect(window.location.hash).not.toContain('accuracy')
  })

  it('previews a work item from execution history beside Resources instead of leaving', async () => {
    await start('#/p/project-1/resources', api({
      searchProjectContext: vi.fn().mockResolvedValue({ items: [contextItem('work', 'w1', 'Sweep heads')], next_cursor: null }),
      readProjectContext: vi.fn().mockResolvedValue(contextDocument('work', 'w1', 'Sweep heads')),
    }))
    fireEvent.click(within(await screen.findByRole('group', { name: 'Search in' })).getByRole('button', { name: /^History/ }))
    fireEvent.click(await screen.findByRole('option', { name: /Sweep heads/ }))
    expect(await inspector('Resource details')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'evidence work:w1' })).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/resources?inspect=resource~work~w1'))
  })

  it('names the Workspace in the titlebar search, apart from Session search', async () => {
    await start('#/p/project-1/general')
    expect(screen.getByRole('button', { name: 'Search Demo' })).toBeInTheDocument()
  })

  it('opens a Thread from a Task as the Thread pane, not under General’s remembered Task', async () => {
    await start('#/p/project-1/general?task=r1&filter=r1', api({
      listChannelMessages: vi.fn().mockResolvedValue({ messages: [message()], has_more: false }),
      listChannelThreads: vi.fn().mockResolvedValue([thread()]),
    }))
    expect(await inspector('Task details')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open thread t1' }))
    expect(await screen.findByRole('complementary', { name: 'Earlier thread' })).toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Task details' })).not.toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/general?thread=t1'))
  })

  it('shows a message from Kanban’s Task beside that Task, never General’s remembered Task or filter', async () => {
    storeLocations({
      lastProjectId: 'project-1',
      seq: 2,
      workspaces: {
        'project-1': {
          current: 'board',
          at: 2,
          views: { general: '/p/project-1/general?task=r9&filter=r9', board: '/p/project-1/board?task=r1' },
        },
      },
    })
    await start('#/p/project-1/board?task=r1', api({
      listChannelMessages: vi.fn().mockResolvedValue({ messages: [message()], has_more: false }),
    }))
    expect(await screen.findByRole('region', { name: 'task r1' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show message m1' }))
    // Beside General the Task it came from stays open: never the Task General remembered.
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/general/m/m1?task=r1'))
    expect(await screen.findByRole('heading', { name: 'General', exact: true, level: 2 })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'task r1' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'task r9' })).not.toBeInTheDocument()
  })

  it.each([
    ['execution history', async () => {
      const history = document.querySelector('details.kubecode-history-nav') as HTMLDetailsElement
      act(() => {
        history.open = true
        history.dispatchEvent(new Event('toggle'))
      })
      fireEvent.click(await within(history).findByRole('button', { name: /Pruning thread/ }))
    }],
    ['a reference in Resources', async () => {
      fireEvent.click(within(await screen.findByRole('region', { name: 'Workspace' })).getByRole('button', { name: 'Resources' }))
      fireEvent.click(await screen.findByRole('option', { name: /Pruning thread/ }))
      fireEvent.click(await screen.findByRole('button', { name: 'Open Thread in General' }))
    }],
  ])('opens a Thread from %s without General’s remembered Task or filter', async (_, open) => {
    storeLocations({
      lastProjectId: 'project-1',
      seq: 2,
      workspaces: {
        'project-1': { current: 'board', at: 2, views: { general: '/p/project-1/general?task=r9&filter=r9', board: '/p/project-1/board' } },
      },
    })
    await start('#/p/project-1/board', api({
      listChannelMessages: vi.fn().mockResolvedValue({ messages: [message()], has_more: false }),
      listChannelThreads: vi.fn().mockResolvedValue([thread()]),
      searchProjectContext: vi.fn().mockResolvedValue({ items: [contextItem('thread', 't1', 'Pruning thread')], next_cursor: null }),
      readProjectContext: vi.fn().mockResolvedValue(contextDocument('thread', 't1', 'Pruning thread')),
    }))
    await screen.findByRole('heading', { name: 'Kanban', level: 2 })
    await open()
    expect(await screen.findByRole('complementary', { name: 'Earlier thread' })).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/general?thread=t1'))
  })

  it('keeps what is open when the current destination is chosen again', async () => {
    const { nav } = await start('#/p/project-1/board?task=r1')
    expect(await inspector('Task details')).toBeInTheDocument()
    fireEvent.click(within(nav).getByRole('button', { name: /^Kanban/ }))
    expect(screen.getByRole('complementary', { name: 'Task details' })).toBeInTheDocument()
    expect(window.location.hash).toBe('#/p/project-1/board?task=r1')
  })
})

describe('The Workspaces navigation', () => {
  function history() {
    return document.querySelector('details.kubecode-history-nav') as HTMLDetailsElement
  }

  it('is one navigation of Workspaces, and the title bar names the Workspace and the place', async () => {
    const { container } = await start('#/p/project-1/board')
    expect(screen.getByRole('navigation', { name: 'Workspaces' })).toBeInTheDocument()
    await screen.findByRole('heading', { name: 'Kanban', level: 2 })
    expect(container.querySelector('.kubecode-topbar-leading')).toHaveTextContent('DemoKanban')
    expect(screen.queryByRole('textbox', { name: 'Search Sessions in all Workspaces' })?.closest('.kubecode-topbar')).toBeFalsy()
    expect(screen.getAllByRole('button', { name: 'Demo' })).toHaveLength(1)
    expect(history().open).toBe(false)
  })

  it('opens a member’s profile over the view from the roster, and Members from execution history', async () => {
    const { nav } = await start('#/p/project-1/board')
    await screen.findByRole('heading', { name: 'Kanban', level: 2 })
    const roster = await within(nav).findByRole('list', { name: 'Agents' })
    fireEvent.click(within(roster).getByRole('button', { name: 'Analyst' }))
    expect(await inspector('Analyst')).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/board?inspect=member~m-analyst'))

    fireEvent.click(within(history()).getByRole('button', { name: 'New session' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
  })

  it('opens Members with the profile when execution history is on screen', async () => {
    const { nav } = await start('#/p/project-1/sessions')
    await screen.findByTestId('agent-session-workspace')
    expect(history().open).toBe(true)
    fireEvent.click(within(await within(nav).findByRole('list', { name: 'Agents' })).getByRole('button', { name: 'Analyst' }))
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/members?member=m-analyst'))
    expect(await inspector('Analyst')).toBeInTheDocument()
  })

  it('lists the private conversations, and marks the one on screen', async () => {
    const analyst = member({ id: 'm-analyst', role: 'specialist', name: 'Analyst', handle: 'analyst', dm_conversation_id: 's-dm' })
    const { nav } = await start('#/p/project-1/general', api({
      listMembers: vi.fn().mockResolvedValue({ members: [member({}), analyst], general_id: 'm-general' }),
      memberDmTurns: vi.fn().mockResolvedValue([]),
    }))
    const direct = await within(nav).findByRole('list', { name: 'Direct messages' })
    fireEvent.click(within(direct).getByRole('button', { name: 'Analyst' }))
    expect(await screen.findByRole('heading', { name: 'Private conversation with Analyst' })).toBeInTheDocument()
    expect(window.location.hash).toBe('#/p/project-1/dm/m-analyst')
    expect(within(direct).getByRole('button', { name: 'Analyst' })).toHaveAttribute('aria-current', 'page')
  })

  it('searches Sessions from execution history and opens the one chosen', async () => {
    await start('#/p/project-1/resources', api({ listConversations: vi.fn().mockResolvedValue([session]) }))
    await screen.findByRole('heading', { name: 'Resources', level: 2 })
    const search = within(history()).getByRole('textbox', { name: 'Search Sessions in all Workspaces' })
    fireEvent.change(search, { target: { value: 'earlier' } })
    expect(history().open).toBe(true)
    expect(within(history()).getByRole('heading', { name: 'Demo', level: 3 })).toBeInTheDocument()
    fireEvent.click(await within(history()).findByRole('button', { name: /^Earlier chat/ }))
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/sessions/c/s1'))
  })

  it('remembers execution history being opened', async () => {
    await start('#/p/project-1/general')
    await screen.findByRole('heading', { name: 'General', exact: true, level: 2 })
    act(() => {
      history().open = true
      history().dispatchEvent(new Event('toggle'))
    })
    await waitFor(() => expect(
      JSON.parse(localStorage.getItem('kubecode:workbench-layout:v2') ?? '{}').historyOpen,
    ).toBe(true))
  })
})

describe('Returning to a place (ADR 0228 §4)', () => {
  /** Six 40px messages in a 100px log; returns a setter for how far it is scrolled. */
  function readableLog() {
    // The official Conversation's scroller sits inside the named log (ADR 0242).
    const log = screen.getByRole('log', { name: 'Messages' }).querySelector('.kubecode-channel-messages') as HTMLElement
    let top = 0
    Object.defineProperty(log, 'scrollTop', { configurable: true, get: () => top, set: (value: number) => { top = value } })
    Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => 240 })
    Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => 100 })
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const id = this.getAttribute('data-message-id')
      const y = id ? (Number(id.slice(1)) - 1) * 40 - top : 0
      return { top: y, bottom: y + (id ? 40 : 100), height: id ? 40 : 100, left: 0, right: 0, width: 0, x: 0, y } as DOMRect
    })
    return (next: number) => {
      top = next
      fireEvent.scroll(log)
    }
  }

  const six = () => api({
    listChannelMessages: vi.fn().mockResolvedValue({
      messages: Array.from({ length: 6 }, (_, index) => message({ id: `m${index + 1}`, seq: index + 1, body: `note ${index + 1}`, task_id: null })),
      has_more: false,
    }),
  })

  afterEach(() => vi.restoreAllMocks())

  it('keeps each place’s draft across a view switch and a Workspace switch, never mixing them', async () => {
    const { nav } = await start('#/p/project-1/general')
    fireEvent.change(await composer(), { target: { value: 'Half a thought' } })

    fireEvent.click(within(nav).getByRole('button', { name: /^Kanban/ }))
    await screen.findByRole('heading', { name: 'Kanban', level: 2 })
    fireEvent.click(within(nav).getAllByRole('button', { name: 'General' })[0])
    expect(await composer()).toHaveValue('Half a thought')

    fireEvent.click(screen.getByRole('button', { name: 'Other' }))
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-2/general'))
    expect(await composer()).toHaveValue('')
    fireEvent.change(await composer(), { target: { value: 'Elsewhere' } })

    fireEvent.click(screen.getByRole('button', { name: 'Demo' }))
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/general'))
    expect(await composer()).toHaveValue('Half a thought')
    fireEvent.click(screen.getByRole('button', { name: 'Other' }))
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-2/general'))
    expect(await composer()).toHaveValue('Elsewhere')
  })

  it('keeps a private draft in its own conversation, never in General', async () => {
    const analyst = member({ id: 'm-analyst', role: 'specialist', name: 'Analyst', handle: 'analyst', dm_conversation_id: 's-dm' })
    const { nav } = await start('#/p/project-1/dm/m-analyst', api({
      listMembers: vi.fn().mockResolvedValue({ members: [member({}), analyst], general_id: 'm-general' }),
      memberDmTurns: vi.fn().mockResolvedValue([]),
    }))
    const privately = await screen.findByLabelText('Message Analyst privately', { selector: 'textarea' })
    fireEvent.change(privately, { target: { value: 'Just between us' } })

    fireEvent.click(within(nav).getAllByRole('button', { name: 'General' })[0])
    expect(await composer()).toHaveValue('')
    const direct = await within(nav).findByRole('list', { name: 'Direct messages' })
    fireEvent.click(within(direct).getByRole('button', { name: 'Analyst' }))
    expect(await screen.findByLabelText('Message Analyst privately', { selector: 'textarea' })).toHaveValue('Just between us')
  })

  it('returns to the message being read, quietly, after a visit to Kanban', async () => {
    const { nav } = await start('#/p/project-1/general', six())
    await screen.findByText('note 6')
    const scrollTo = readableLog()
    scrollTo(40)
    await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))))

    fireEvent.click(within(nav).getByRole('button', { name: /^Kanban/ }))
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/board'))
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    fireEvent.click(within(nav).getAllByRole('button', { name: 'General' })[0])
    // The position was folded in when General was left: Back and a reload land on it too.
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/general/m/m3'))
    await waitFor(() => expect(scroll).toHaveBeenCalled())
    expect(document.activeElement?.getAttribute('data-message-id')).toBeNull()
  })

  it('lands on the message being read with the browser Back after leaving General', async () => {
    const { nav } = await start('#/p/project-1/general', six())
    await screen.findByText('note 6')
    const scrollTo = readableLog()
    scrollTo(40)
    await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))))

    fireEvent.click(within(nav).getByRole('button', { name: /^Kanban/ }))
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/board'))
    Element.prototype.scrollIntoView = vi.fn()
    await act(async () => {
      window.history.back()
      await new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }))
    })
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/general/m/m3'))
    expect(await screen.findByRole('heading', { name: 'General', exact: true, level: 2 })).toBeInTheDocument()
  })

  it('follows the conversation again when the researcher was at the newest message', async () => {
    const { nav } = await start('#/p/project-1/general/m/m2', six())
    await screen.findByText('note 6')
    const scrollTo = readableLog()
    scrollTo(140)
    await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))))
    fireEvent.click(within(nav).getByRole('button', { name: 'Resources' }))
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/resources'))
    fireEvent.click(within(nav).getAllByRole('button', { name: 'General' })[0])
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/general'))
  })

  it('records the reading position when the page is hidden', async () => {
    await start('#/p/project-1/general', six())
    await screen.findByText('note 6')
    const scrollTo = readableLog()
    scrollTo(80)
    await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))))
    act(() => { window.dispatchEvent(new Event('pagehide')) })
    const stored = JSON.parse(localStorage.getItem('kubecode:workspace-location:v1') ?? '{}')
    expect(stored.workspaces['project-1'].views.general).toBe('/p/project-1/general/m/m4')
  })

  it('on a phone, a link that moves the place closes the navigation sheet so the place is visible', async () => {
    narrowScreen()
    await start('#/p/project-1/general', six())
    await screen.findByText('note 6')
    if (!screen.queryByRole('navigation', { name: 'Workspaces' })) {
      fireEvent.click(screen.getByRole('button', { name: 'Toggle navigation' }))
    }
    expect(await screen.findByRole('navigation', { name: 'Workspaces' })).toBeInTheDocument()
    act(() => {
      window.history.pushState(null, '', '/#/p/project-1/resources')
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Workspaces' })).toBeNull())
    expect(window.location.hash).toBe('#/p/project-1/resources')
  })

  it('on a phone, lands on the message being read once the navigation closes', async () => {
    narrowScreen()
    const { nav } = await start('#/p/project-1/general', six())
    await screen.findByText('note 6')
    const scrollTo = readableLog()
    scrollTo(40)
    await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))))
    Element.prototype.scrollIntoView = vi.fn()
    fireEvent.click(within(nav).getByRole('button', { name: 'Resources' }))
    await waitFor(() => expect(window.location.hash).toBe('#/p/project-1/resources'))
    fireEvent.click(screen.getByRole('button', { name: 'Toggle navigation' }))
    fireEvent.click(within(await screen.findByRole('region', { name: 'Workspace' })).getAllByRole('button', { name: 'General' })[0])
    await waitFor(() => expect(document.activeElement).toHaveAttribute('data-message-id', 'm3'))
  })
})
