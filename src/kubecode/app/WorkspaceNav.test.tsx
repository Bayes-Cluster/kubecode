import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Conversation, Member, TaskCard } from '../api'
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
    onOpen: vi.fn(), onOpenDm: vi.fn(), onOpenDraft: vi.fn(), onOpenMember: vi.fn(), onOpenSession: vi.fn(), onOpenTask: vi.fn(),
  }
  render(
    <WorkspaceNav
      active="general"
      members={[member({}), member({ id: 'm2', name: 'Writer', handle: 'writer', state: 'setup_required' })]}
      needsYouDrafts={[]}
      needsYouSessions={[]}
      needsYouTasks={[]}
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

  it('gathers what waits for the researcher and opens it', () => {
    const handlers = nav({
      needsYouTasks: [task({}), task({ id: 'r2', title: 'Quant', stage: 'in_progress', condition: 'needs_input' })],
      needsYouSessions: [{ id: 's9', project_id: 'p1', title: 'Fix build' } as unknown as Conversation],
    })
    expect(screen.getByText('kubecode.nav.needsYou').closest('summary')).toHaveTextContent('3')
    fireEvent.click(screen.getByRole('button', { name: /Pruning/ }))
    expect(handlers.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }))
    expect(screen.getByText('kubecode.nav.needsReview')).toBeInTheDocument()
    expect(screen.getByText('kubecode.nav.needsInput')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Fix build/ }))
    expect(handlers.onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 's9' }))
  })

  it('says nothing is waiting, and lists members with a private message only for the active ones', () => {
    const handlers = nav()
    expect(screen.getByText('kubecode.nav.needsYouNone')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '@analyst' }))
    expect(handlers.onOpenMember).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }))
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.members.messagePrivately:{"name":"Analyst"}' }))
    expect(handlers.onOpenDm).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }))
    expect(screen.queryByRole('button', { name: 'kubecode.members.messagePrivately:{"name":"Writer"}' }))
      .not.toBeInTheDocument()
    expect(screen.getByText('kubecode.members.state.setup_required')).toBeInTheDocument()
  })

  it('lists proposals that are not on the board as waiting for a decision', () => {
    const handlers = nav({
      needsYouDrafts: [{
        id: 'd1', project_id: 'p1', title: 'Quantize first', question: '?', revision: 2,
        proposed_by: 'agent', updated_at: '',
      }],
    })
    expect(screen.getByText('kubecode.nav.needsYou').closest('summary')).toHaveTextContent('1')
    fireEvent.click(screen.getByRole('button', { name: /Quantize first/ }))
    expect(handlers.onOpenDraft).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1' }))
    expect(screen.getByText('kubecode.nav.needsProposal')).toBeInTheDocument()
  })
})
