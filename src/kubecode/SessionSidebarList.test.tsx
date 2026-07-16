import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import { SessionSidebarList } from './SessionSidebarList'
import type { Conversation, KubecodeApi } from './api'

const t = createTranslator('en')

describe('session sidebar list', () => {
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
