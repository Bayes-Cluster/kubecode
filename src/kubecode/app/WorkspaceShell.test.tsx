import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { KubecodeApp } from '../App'

import type { KubecodeApi, Member, TaskCard } from '../api'

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
  ResearchWorkspace: ({ researchId, onClose, backLabel }: { researchId: string; onClose: () => void; backLabel?: string }) => (
    <section aria-label={`task ${researchId}`}>
      <button type="button" onClick={onClose}>{backLabel ?? 'Back to Sessions'}</button>
    </section>
  ),
}))

beforeEach(() => localStorage.clear())

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
})
