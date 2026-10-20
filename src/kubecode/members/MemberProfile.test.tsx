import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Member } from '../api'
import { fakeNavigation, fakeServices, renderInspector } from '../app/inspector/inspectorTesting'
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
  it('shows who the agent is and how to talk to it privately, as content only', () => {
    const onOpenDm = vi.fn()
    render(<MemberProfile member={analyst} t={t} onOpenDm={onOpenDm} />)
    expect(screen.getByText('@analyst')).toBeInTheDocument()
    expect(screen.getByText('Run the analyses.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /messagePrivately/ }))
    expect(onOpenDm).toHaveBeenCalledWith(analyst)
    // The inspector draws the aside, the title, and Close.
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'kubecode.nav.closeDetail' })).not.toBeInTheDocument()
  })

  it('offers no private message to a member that is not active', () => {
    render(<MemberProfile member={{ ...analyst, state: 'setup_required' }} t={t} onOpenDm={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /messagePrivately/ })).not.toBeInTheDocument()
  })
})

describe('MemberPanel', () => {
  it('shows the profile in the inspector under one header, and opens the private conversation', () => {
    const navigation = fakeNavigation()
    renderInspector({
      navigation,
      services: fakeServices({ roster: [analyst] }),
      stack: [{ kind: 'member', id: 'm1' }],
    })
    expect(screen.getByRole('complementary', { name: 'Analyst' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Analyst', level: 3 })).toBeInTheDocument()
    expect(screen.getByText('Ready')).toBeInTheDocument()
    expect(screen.getByText('Run the analyses.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Message Analyst privately' }))
    expect(navigation.openPlace).toHaveBeenCalledWith({ view: 'dm', member: 'm1' })
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }))
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
  })

  it('says a member who left the roster is no longer available', () => {
    renderInspector({ services: fakeServices({ roster: [] }), stack: [{ kind: 'member', id: 'm1' }] })
    expect(screen.getByRole('complementary', { name: 'Member details' })).toBeInTheDocument()
    expect(screen.getByText('This item is no longer available.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close details' })).toBeInTheDocument()
  })
})
