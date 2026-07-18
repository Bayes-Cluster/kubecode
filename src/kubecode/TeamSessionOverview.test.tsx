import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { TeamSessionOverview } from './TeamSessionOverview'
import type { TeamSnapshot } from './api'

const snapshot = {
  team: { id: 'team-1', title: 'Compiler team' },
  leader_conversation: { id: 'leader', title: 'Compiler team', agent_id: 'codex' },
  conversations: [
    { id: 'leader', agent_id: 'codex' },
    { id: 'reviewer', agent_id: 'claude_code' },
  ],
  members: [
    { id: 'member-1', conversation_id: 'leader', name: 'Lead', status: 'working' },
    { id: 'member-2', conversation_id: 'reviewer', name: 'Reviewer', status: 'idle' },
  ],
  tasks: [
    { id: 'task-1', title: 'Implement parser', description: 'Parser', status: 'accepted' },
    { id: 'task-2', title: 'Review parser', description: 'Review', status: 'in_progress' },
  ],
} as TeamSnapshot

describe('TeamSessionOverview', () => {
  it('shows live members without duplicating task progress and switches to a teammate chat', () => {
    const onSelectMember = vi.fn()
    render(
      <TeamSessionOverview
        activeConversationId="leader"
        onSelectMember={onSelectMember}
        snapshot={snapshot}
      />,
    )

    expect(screen.getByText('Compiler team')).toBeInTheDocument()
    expect(screen.queryByText('1/2')).not.toBeInTheDocument()
    expect(screen.queryByText('Implement parser')).not.toBeInTheDocument()
    expect(screen.queryByText('Review parser')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reviewer' }))
    expect(onSelectMember).toHaveBeenCalledWith('reviewer')
  })
})
