import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { SidebarProvider } from '@/components/ui/sidebar'
import { createTranslator } from '@/lib/i18n'

import type { Member } from '../api'
import { permissionItem, proposalItem, questionItem, snapshot } from '../attention/attentionFixtures'
import { needsYouFromAttention } from '../attention/attentionTargets'
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

function nav(overrides: Partial<WorkspaceNavProps> = {}) {
  const handlers = {
    onInspectMember: vi.fn(), onOpen: vi.fn(), onOpenDm: vi.fn(), onOpenTarget: vi.fn(),
  }
  render(
    <SidebarProvider><WorkspaceNav
      active="general"
      members={[member({}), member({ id: 'm2', name: 'Writer', handle: 'writer', state: 'setup_required' })]}
      needsYou={[]}
      t={t}
      taskCount={0}
      {...handlers}
      {...overrides}
    /></SidebarProvider>,
  )
  return handlers
}

describe('WorkspaceNav', () => {
  it('offers the five places, marks the current one, and counts the board', () => {
    const handlers = nav({ taskCount: 3 })
    const group = screen.getByRole('region', { name: 'kubecode.nav.workspace' })
    expect(within(group).getByRole('button', { name: 'kubecode.channel.general' })).toHaveAttribute('aria-current', 'page')
    expect(within(group).getByRole('button', { name: /^kubecode\.nav\.board/ })).not.toHaveAttribute('aria-current')
    for (const [name, view] of [
      [/^kubecode\.nav\.board/, 'board'],
      ['kubecode.nav.resources', 'resources'],
      [/^kubecode\.nav\.needsYou/, 'needs-you'],
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
      within(group).getByRole('button', { name: /^kubecode\.nav\.needsYou/ }),
      within(group).getByRole('button', { name: 'kubecode.nav.members' }),
      within(group).getByRole('heading', { name: 'kubecode.nav.roster' }),
      within(group).getByRole('list', { name: 'kubecode.nav.roster' }),
      within(group).getByRole('heading', { name: 'kubecode.nav.directMessages' }),
    ]
    for (let index = 1; index < order.length; index += 1) {
      expect(order[index - 1].compareDocumentPosition(order[index]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
  })

  it('draws the places, members, and private conversations as official Sidebar menus', () => {
    nav({ active: 'board', members: [member({ dm_conversation_id: 'c1' })] })
    const board = screen.getByRole('button', { name: /^kubecode\.nav\.board/ })
    expect(board).toHaveAttribute('data-slot', 'sidebar-menu-button')
    expect(board).toHaveAttribute('data-active', 'true')
    expect(board).toHaveAttribute('aria-current', 'page')
    expect(board.closest('[data-slot="sidebar-menu"]')).not.toBeNull()
    expect(screen.getByRole('heading', { name: 'kubecode.nav.roster' })).toHaveAttribute('data-slot', 'sidebar-group-label')
    const direct = screen.getByRole('list', { name: 'kubecode.nav.directMessages' })
    expect(direct).toHaveAttribute('data-slot', 'sidebar-menu')
    expect(within(direct).getByRole('button', { name: 'Analyst' })).toHaveAttribute('data-slot', 'sidebar-menu-button')
    const roster = screen.getByRole('list', { name: 'kubecode.nav.roster' })
    expect(within(roster).getByRole('button', { name: 'kubecode.members.messagePrivately:{"name":"Analyst"}' }))
      .toHaveAttribute('data-sidebar', 'menu-action')
  })

  it('marks nothing on execution history or a question', () => {
    nav({ active: null })
    const group = screen.getByRole('region', { name: 'kubecode.nav.workspace' })
    expect(within(group).queryAllByRole('button').filter((button) => button.hasAttribute('aria-current'))).toEqual([])
  })

  it('makes Needs you a place of its own that counts what waits, never a list folded into the navigation', () => {
    const entries = needsYouFromAttention(
      snapshot({ items: [permissionItem(), questionItem(), proposalItem()] }),
      new Set(),
      createTranslator('en'),
      { presentation: 'screen' },
    )
    const handlers = nav({ active: 'needs-you', needsYou: entries })
    const place = screen.getByRole('button', { name: /^kubecode\.nav\.needsYou/ })
    expect(place).toHaveAttribute('aria-current', 'page')
    expect(place).toHaveTextContent('3')
    expect(place.querySelector('[data-variant="warning"]')).not.toBeNull()
    expect(screen.queryByRole('button', { name: /Run pytest/ })).not.toBeInTheDocument()
    fireEvent.click(place)
    expect(handlers.onOpen).toHaveBeenLastCalledWith('needs-you')
  })

  it('counts nothing as a quiet zero while the list loads or nothing waits', () => {
    nav({ needsYou: [] })
    const place = screen.getByRole('button', { name: /^kubecode\.nav\.needsYou/ })
    expect(place.querySelector('[data-variant="warning"]')).toBeNull()
  })

  it('says on General how many of the researcher’s messages were not delivered', () => {
    nav({ undeliveredGeneral: 2 })
    const general = screen.getByRole('button', { name: /^kubecode\.channel\.general/ })
    expect(general).toHaveTextContent('kubecode.nav.notDelivered:{"count":2}')
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
    expect(rows.map((row) => row.querySelector(':scope > span:last-child')?.textContent)).toEqual(['Reviewer', 'Writer'])
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
