import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import { SessionSidebarList } from './SessionSidebarList'
import type { Conversation, KubecodeApi, TeamSnapshot } from './api'

const t = createTranslator('en')

describe('session sidebar list', () => {
  beforeEach(() => localStorage.clear())

  it('renders persisted Team membership from the Session summary without Team snapshots', () => {
    render(
      <SessionSidebarList
        activeConversationId="session-1"
        api={{} as KubecodeApi}
        conversations={[{
          ...session('session-1', 'Persistent leader', 'completed'),
          team_id: 'team-1',
          team_role: 'leader',
        }]}
        onConversationCreated={vi.fn()}
        onConversationRemoved={vi.fn()}
        onConversationUpdated={vi.fn()}
        onError={vi.fn()}
        onSelect={vi.fn()}
        t={t}
        teams={[]}
      />,
    )

    expect(screen.getByText('Team · Leader')).toBeInTheDocument()
  })

  it('groups status-first and filters sessions without losing the selected session', () => {
    const onSelect = vi.fn()
    render(
      <SessionSidebarList
        activeConversationId="session-1"
        api={{} as KubecodeApi}
        conversations={[
          session('session-1', 'Needs permission', 'waiting_permission'),
          session('session-2', 'Documentation', 'completed'),
          {
            ...session('session-3', 'Try another approach', 'completed'),
            parent_conversation_id: 'session-1',
            relationship: 'fork',
          },
        ]}
        onConversationCreated={vi.fn()}
        onConversationRemoved={vi.fn()}
        onConversationUpdated={vi.fn()}
        onError={vi.fn()}
        onSelect={onSelect}
        t={t}
      />,
    )

    expect(screen.getByText('Needs input')).toBeInTheDocument()
    expect(screen.getByText('Fork of Needs permission')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Needs permission' })).toHaveAttribute(
      'data-variant',
      'ghost',
    )
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search sessions' }), {
      target: { value: 'doc' },
    })
    expect(screen.queryByRole('button', { name: 'Needs permission' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Documentation' }))
    expect(onSelect).toHaveBeenCalledWith('session-2')
  })

  it('renders each Team as a named hierarchy with its Leader before its teammates', () => {
    const leader = session('session-leader', 'Research lead', 'completed')
    const teammate = session('session-reviewer', 'Backend reviewer', 'running')
    const solo = session('session-solo', 'Independent task', 'completed')
    render(
      <SessionSidebarList
        activeConversationId="session-reviewer"
        api={{} as KubecodeApi}
        conversations={[teammate, solo, leader]}
        onConversationCreated={vi.fn()}
        onConversationRemoved={vi.fn()}
        onConversationUpdated={vi.fn()}
        onError={vi.fn()}
        onSelect={vi.fn()}
        t={t}
        teams={[{
          team: { id: 'team-1', title: 'Paper review team' },
          members: [
            { conversation_id: teammate.id, role: 'teammate', name: 'Reviewer' },
            { conversation_id: leader.id, role: 'leader', name: 'Lead' },
          ],
          conversations: [teammate, leader],
          tasks: [],
          leader_conversation: leader,
        } as TeamSnapshot]}
      />,
    )

    const team = screen.getByRole('group', { name: 'Paper review team' })
    const teamSessions = Array.from(team.querySelectorAll<HTMLButtonElement>('.kubecode-session-row'))
    expect(teamSessions.map((row) => row.getAttribute('aria-label'))).toEqual([
      'Research lead',
      'Backend reviewer',
    ])
    expect(team).not.toContainElement(screen.getByRole('button', { name: 'Independent task' }))
  })

  it('confirms deleting a Leader and removes the complete Team from navigation', async () => {
    const leader = session('session-leader', 'Research lead', 'completed')
    const teammate = session('session-reviewer', 'Backend reviewer', 'completed')
    const deleteConversation = vi.fn().mockResolvedValue(undefined)
    const onConversationRemoved = vi.fn()
    render(
      <SessionSidebarList
        activeConversationId="session-leader"
        api={{ deleteConversation } as unknown as KubecodeApi}
        conversations={[leader, teammate]}
        onConversationCreated={vi.fn()}
        onConversationRemoved={onConversationRemoved}
        onConversationUpdated={vi.fn()}
        onError={vi.fn()}
        onSelect={vi.fn()}
        t={t}
        teams={[{
          team: { id: 'team-1', title: 'Paper review team' },
          members: [
            { conversation_id: leader.id, role: 'leader', name: 'Lead' },
            { conversation_id: teammate.id, role: 'teammate', name: 'Reviewer' },
          ],
          conversations: [leader, teammate],
          tasks: [],
          leader_conversation: leader,
        } as TeamSnapshot]}
      />,
    )

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Actions for Research lead' }), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    })
    fireEvent.click(await screen.findByText('Delete'))

    expect(deleteConversation).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Delete Paper review team?' })).toBeInTheDocument()
    expect(screen.getByText(/Leader and 1 teammates/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(deleteConversation).toHaveBeenCalledWith('session-leader'))
    expect(onConversationRemoved).toHaveBeenCalledWith('session-leader')
    expect(onConversationRemoved).toHaveBeenCalledWith('session-reviewer')
  })

  it('does not let a user delete a teammate outside the Leader workflow', async () => {
    const leader = session('session-leader', 'Research lead', 'completed')
    const teammate = session('session-reviewer', 'Backend reviewer', 'completed')
    const deleteConversation = vi.fn().mockResolvedValue(undefined)
    render(
      <SessionSidebarList
        activeConversationId="session-reviewer"
        api={{ deleteConversation } as unknown as KubecodeApi}
        conversations={[leader, teammate]}
        onConversationCreated={vi.fn()}
        onConversationRemoved={vi.fn()}
        onConversationUpdated={vi.fn()}
        onError={vi.fn()}
        onSelect={vi.fn()}
        t={t}
        teams={[{
          team: { id: 'team-1', title: 'Paper review team' },
          members: [
            { conversation_id: leader.id, role: 'leader', name: 'Lead' },
            { conversation_id: teammate.id, role: 'teammate', name: 'Reviewer' },
          ],
          conversations: [leader, teammate],
          tasks: [],
          leader_conversation: leader,
        } as TeamSnapshot]}
      />,
    )

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Actions for Backend reviewer' }), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    })
    expect(screen.queryByText('Delete')).not.toBeInTheDocument()
    expect(deleteConversation).not.toHaveBeenCalled()
    expect(screen.queryByRole('heading', { name: /Delete Paper review team/ })).not.toBeInTheDocument()
  })
})

function session(id: string, title: string, status: Conversation['latest_run_status']): Conversation {
  return {
    id,
    project_id: 'project-1',
    agent_id: 'codex',
    provider_session_id: null,
    title,
    manual_title: null,
    agent_title: title,
    created_at: '2026-07-16T06:00:00Z',
    updated_at: '2026-07-16T06:00:00Z',
    latest_run_status: status,
  }
}
