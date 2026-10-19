import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Member } from '../api'
import { MemberProfile } from './MemberProfile'

const t = ((key: string, values?: Record<string, string | number>) => (
  values ? `${key}:${JSON.stringify(values)}` : key
)) as never

const analyst: Member = {
  id: 'm1', project_id: 'p1', role: 'specialist', template: 'analysis', name: 'Analyst', handle: 'analyst',
  spec: { agent_id: 'opencode', config: {}, instructions: 'Run the analyses.' },
  public_conversation_id: 's1', dm_conversation_id: null, state: 'active', setup_error: null,
  setup_code: null, revision: 1, created_at: '', updated_at: '', removed_at: null,
}

describe('MemberProfile', () => {
  it('shows who the agent is and how to talk to it privately', () => {
    const onOpenDm = vi.fn()
    const onClose = vi.fn()
    render(<MemberProfile member={analyst} t={t} onClose={onClose} onOpenDm={onOpenDm} />)
    expect(screen.getByText('@analyst')).toBeInTheDocument()
    expect(screen.getByText('Run the analyses.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /messagePrivately/ }))
    expect(onOpenDm).toHaveBeenCalledWith(analyst)
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.nav.closeDetail' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('offers no private message to a member that is not active', () => {
    render(
      <MemberProfile member={{ ...analyst, state: 'setup_required' }} t={t} onClose={vi.fn()} onOpenDm={vi.fn()} />,
    )
    expect(screen.queryByRole('button', { name: /messagePrivately/ })).not.toBeInTheDocument()
  })
})
