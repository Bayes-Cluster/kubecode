import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { fakeNavigation, fakeServices, renderInspector } from '../app/inspector/inspectorTesting'
import { member } from './memberFixtures'

const analyst = member({
  id: 'm1', name: 'Analyst', handle: 'analyst',
  spec: { agent_id: 'opencode', config: {}, instructions: 'Run the analyses.' },
})

describe('MemberPanel', () => {
  it('shows who the member is in the inspector, and the ways to talk to them and manage them', () => {
    const navigation = fakeNavigation()
    renderInspector({ navigation, services: fakeServices({ roster: [analyst] }), stack: [{ kind: 'member', id: 'm1' }] })
    expect(screen.getByRole('complementary', { name: 'Analyst' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Analyst', level: 3 })).toBeInTheDocument()
    expect(screen.getByText('@analyst')).toBeInTheDocument()
    expect(screen.getByText('Specialist · Analysis')).toBeInTheDocument()
    expect(screen.getByText('Responsibility')).toBeInTheDocument()
    expect(screen.getByText('Provider')).toBeInTheDocument()
    expect(screen.getByText('OpenCode')).toBeInTheDocument()
    // Membership is not activity: an active member carries no status.
    expect(screen.queryByText('Ready')).not.toBeInTheDocument()
    expect(screen.getByText('Run the analyses.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Message Analyst privately' }))
    expect(navigation.openPlace).toHaveBeenCalledWith({ view: 'dm', member: 'm1' })
    fireEvent.click(screen.getByRole('button', { name: 'Manage in Members' }))
    expect(navigation.openPlace).toHaveBeenCalledWith({ view: 'members' }, { inspect: { kind: 'member', id: 'm1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }))
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
  })

  it('offers no private message to a member that needs setup, says so, and is not managed from Members itself', () => {
    const navigation = fakeNavigation({ location: { place: { view: 'members' }, inspector: [] } })
    renderInspector({
      navigation,
      services: fakeServices({ roster: [{ ...analyst, state: 'setup_required' }] }),
      stack: [{ kind: 'member', id: 'm1' }],
    })
    expect(screen.getAllByText('Needs setup').length).toBeGreaterThan(0)
    expect(screen.getByText('Membership')).toBeInTheDocument()
    expect(screen.getByText('Idle')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Message Analyst privately' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Manage in Members' })).not.toBeInTheDocument()
  })

  it('shows long instructions collapsed until asked', () => {
    const long = { ...analyst, spec: { ...analyst.spec, instructions: 'x'.repeat(400) } }
    renderInspector({ services: fakeServices({ roster: [long] }), stack: [{ kind: 'member', id: 'm1' }] })
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument()
  })

  it('keeps what a member executes apart from membership, and shows the manager\'s locked restrictions', () => {
    const general = member({ id: 'g', name: 'General', handle: 'general', role: 'general', template: 'general' })
    renderInspector({
      services: fakeServices({ roster: [general], sessionCatalog: [{ id: 's-g', latest_run_status: 'running' }] as never }),
      stack: [{ kind: 'member', id: 'g' }],
    })
    expect(screen.getByText('Execution')).toBeInTheDocument()
    // Each fact is a shadcn Field (ADR 0244).
    expect(screen.getByText('Execution').closest('[data-slot="field"]')).toHaveTextContent('Working')
    expect(screen.getByText('Working')).toBeInTheDocument()
    expect(screen.queryByText('Membership')).not.toBeInTheDocument()
    const restrictions = screen.getByRole('region', { name: 'Runtime restrictions' })
    expect(restrictions).toHaveTextContent('Read-only tools and a locked mode')
  })

  it('says a member who left the roster is no longer available', () => {
    renderInspector({ services: fakeServices({ roster: [] }), stack: [{ kind: 'member', id: 'm1' }] })
    expect(screen.getByRole('complementary', { name: 'Member details' })).toBeInTheDocument()
    expect(screen.getByText('This item is no longer available.')).toBeInTheDocument()
  })
})
