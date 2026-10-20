import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Conversation, Member, TaskCard } from '../api'
import { needsYouFromCurrentSources } from './location/needsYou'
import { WorkspaceNav, type WorkspaceNavProps } from './WorkspaceNav'

const t = ((key: string, values?: Record<string, string | number>) => (
  values ? `${key}:${JSON.stringify(values)}` : key
)) as never

const member = (overrides: Partial<Member>): Member => ({
  id: 'm1', project_id: 'p1', role: 'specialist', template: 'analysis', name: 'Analyst', handle: 'analyst',
  spec: { agent_id: 'opencode', config: {}, instructions: '' }, public_conversation_id: 's1',
  dm_conversation_id: null, state: 'active', setup_error: null, setup_code: null, revision: 1,
  created_at: '', updated_at: '', removed_at: null, ...overrides,
})

const task = (overrides: Partial<TaskCard>): TaskCard => ({
  id: 'r1', project_id: 'p1', title: 'Pruning', question: '?', stage: 'review', condition: 'none',
  condition_reason: null, revision: 1, approved_revision: 1, admitted_at: '', origin: 'conversation',
  authorizing_message_id: null, participants: [], open_questions: 0, review_requested: true,
  updated_at: '', ...overrides,
})

function nav(overrides: Partial<WorkspaceNavProps> = {}) {
  const handlers = {
    onInspectMember: vi.fn(), onOpen: vi.fn(), onOpenDm: vi.fn(), onOpenTarget: vi.fn(),
  }
  render(
    <WorkspaceNav
      active="general"
      members={[member({}), member({ id: 'm2', name: 'Writer', handle: 'writer', state: 'setup_required' })]}
      needsYou={[]}
      t={t}
      taskCount={0}
      {...handlers}
      {...overrides}
    />,
  )
  return handlers
}

describe('WorkspaceNav', () => {
  it('offers the four places, marks the current one, and counts the board', () => {
    const handlers = nav({ taskCount: 3 })
    const group = screen.getByRole('region', { name: 'kubecode.nav.workspace' })
    expect(within(group).getByRole('button', { name: 'kubecode.channel.general' })).toHaveAttribute('aria-current', 'page')
    expect(within(group).getByRole('button', { name: /^kubecode\.nav\.board/ })).not.toHaveAttribute('aria-current')
    for (const [name, view] of [
      [/^kubecode\.nav\.board/, 'board'],
      ['kubecode.nav.resources', 'resources'],
      ['kubecode.nav.members', 'members'],
      ['kubecode.channel.general', 'general'],
    ] as const) {
      fireEvent.click(within(group).getByRole('button', { name }))
      expect(handlers.onOpen).toHaveBeenLastCalledWith(view)
    }
  })

  it('orders the places General, Kanban, Resources, Needs you, then Members and the members under visible headings', () => {
    nav({ members: [member({ dm_conversation_id: 'c1' })] })
    const group = screen.getByRole('region', { name: 'kubecode.nav.workspace' })
    const order = [
      within(group).getByRole('button', { name: 'kubecode.channel.general' }),
      within(group).getByRole('button', { name: /^kubecode\.nav\.board/ }),
      within(group).getByRole('button', { name: 'kubecode.nav.resources' }),
      within(group).getByText('kubecode.nav.needsYou').closest('summary') as HTMLElement,
      within(group).getByRole('button', { name: 'kubecode.nav.members' }),
      within(group).getByRole('heading', { name: 'kubecode.nav.roster' }),
      within(group).getByRole('list', { name: 'kubecode.nav.roster' }),
      within(group).getByRole('heading', { name: 'kubecode.nav.directMessages' }),
    ]
    for (let index = 1; index < order.length; index += 1) {
      expect(order[index - 1].compareDocumentPosition(order[index]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
  })

  it('marks nothing on execution history or a question', () => {
    nav({ active: null })
    const group = screen.getByRole('region', { name: 'kubecode.nav.workspace' })
    expect(within(group).queryAllByRole('button').filter((button) => button.hasAttribute('aria-current'))).toEqual([])
  })

  it('gathers what waits for the researcher and opens where each one says', () => {
    const entries = needsYouFromCurrentSources(
      [task({}), task({ id: 'r2', title: 'Quant', stage: 'in_progress', condition: 'needs_input' })],
      [{ id: 'd1', project_id: 'p1', title: 'Quantize first', question: '?', revision: 2, proposed_by: 'agent', updated_at: '' }],
      [{ id: 's9', project_id: 'p1', title: 'Fix build' } as unknown as Conversation],
      t,
    )
    const handlers = nav({ needsYou: entries })
    const summary = screen.getByText('kubecode.nav.needsYou').closest('summary')
    expect(summary).toHaveTextContent('4')
    expect(summary?.closest('details')).toHaveAttribute('open')

    fireEvent.click(screen.getByRole('button', { name: /Pruning/ }))
    expect(handlers.onOpenTarget).toHaveBeenLastCalledWith({ place: { view: 'board' }, inspect: { kind: 'task', id: 'r1' } })
    fireEvent.click(screen.getByRole('button', { name: /Quantize first/ }))
    expect(handlers.onOpenTarget).toHaveBeenLastCalledWith({ place: { view: 'general' }, inspect: { kind: 'task', id: 'd1' } })
    fireEvent.click(screen.getByRole('button', { name: /Fix build/ }))
    expect(handlers.onOpenTarget).toHaveBeenLastCalledWith({ session: { projectId: 'p1', conversationId: 's9' } })
    for (const reason of ['kubecode.nav.needsReview', 'kubecode.nav.needsInput', 'kubecode.nav.needsProposal', 'kubecode.nav.needsPermission']) {
      expect(screen.getByText(reason)).toBeInTheDocument()
    }
  })

  it('says nothing is waiting, and keeps the disclosure closed', () => {
    nav()
    expect(screen.getByText('kubecode.nav.needsYouNone')).toBeInTheDocument()
    expect(screen.getByText('kubecode.nav.needsYou').closest('details')).not.toHaveAttribute('open')
  })

  it('opens a member’s profile from their name and a private conversation from its action', () => {
    const handlers = nav()
    const roster = screen.getByRole('list', { name: 'kubecode.nav.roster' })
    fireEvent.click(within(roster).getByRole('button', { name: 'Analyst' }))
    expect(handlers.onInspectMember).toHaveBeenCalledWith('m1')
    expect(within(roster).getByText('@analyst')).toBeInTheDocument()
    fireEvent.click(within(roster).getByRole('button', { name: 'kubecode.members.messagePrivately:{"name":"Analyst"}' }))
    expect(handlers.onOpenDm).toHaveBeenCalledWith('m1')
    // Only a membership that needs the researcher is a status, and it cannot be messaged yet.
    expect(within(roster).queryByRole('button', { name: 'kubecode.members.messagePrivately:{"name":"Writer"}' }))
      .not.toBeInTheDocument()
    expect(within(roster).getByText('kubecode.members.state.setup_required')).toBeInTheDocument()
    expect(within(roster).queryByText('kubecode.members.state.active')).not.toBeInTheDocument()
    // The same identity as everywhere: the role in words.
    expect(within(roster).getAllByText(/kubecode\.identity\.specialist/).length).toBeGreaterThan(0)
  })

  it('lists the private conversations that exist, and marks the open one', () => {
    const handlers = nav({
      active: 'dm:m3',
      members: [
        member({}),
        member({ id: 'm3', name: 'Reviewer', handle: 'reviewer', dm_conversation_id: 'c3' }),
        member({ id: 'm4', name: 'Writer', handle: 'writer', dm_conversation_id: 'c4' }),
      ],
    })
    const direct = screen.getByRole('list', { name: 'kubecode.nav.directMessages' })
    const rows = within(direct).getAllByRole('button')
    expect(rows.map((row) => row.querySelector('.kubecode-research-nav-title')?.textContent)).toEqual(['Reviewer', 'Writer'])
    expect(rows[0]).toHaveAttribute('aria-current', 'page')
    expect(rows[1]).not.toHaveAttribute('aria-current')
    fireEvent.click(rows[1])
    expect(handlers.onOpenDm).toHaveBeenCalledWith('m4')
  })

  it('shows a private conversation being opened before the roster knows of it', () => {
    nav({ active: 'dm:m1' })
    const direct = screen.getByRole('list', { name: 'kubecode.nav.directMessages' })
    expect(within(direct).getByRole('button', { name: 'Analyst' })).toHaveAttribute('aria-current', 'page')
  })

  it('has no Direct messages list before any private conversation exists', () => {
    nav()
    expect(screen.queryByRole('list', { name: 'kubecode.nav.directMessages' })).not.toBeInTheDocument()
  })
})
