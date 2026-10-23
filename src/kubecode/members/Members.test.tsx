import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { AgentDescriptor, KubecodeApi, Member, MemberDefaults } from '../api'
import { ApiError } from '../api'
import { MemberDefaultsPanel } from './MemberDefaultsPanel'
import { MemberRoster } from './MemberRoster'
import { MembersView } from './MembersView'
import { createPlaceMemory } from '../app/location/placeMemory'
import { PlaceMemoryProvider } from '../app/location/PlaceMemoryProvider'
import { nextFrame, stubScrollGeometry } from '@/test/scrollGeometry'

const t = ((key: string, values?: Record<string, string | number>) => (
  values ? `${key}:${JSON.stringify(values)}` : key
)) as never

const agents = [
  { id: 'opencode', available: true },
  { id: 'codex', available: false },
] as unknown as AgentDescriptor[]

/** Picks an option from a shadcn Select (Radix): the trigger is a combobox, the options a listbox. */
function choose(trigger: HTMLElement, option: string) {
  expect(trigger).toHaveAttribute('role', 'combobox')
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('option', { name: option }))
}

function member(overrides: Partial<Member> = {}): Member {
  return {
    id: 'm-general', project_id: 'p1', role: 'general', template: 'general', name: 'General',
    handle: 'general', spec: { agent_id: 'opencode', config: {}, instructions: 'Manage.' },
    public_conversation_id: 's1', dm_conversation_id: null, state: 'active', setup_error: null, setup_code: null,
    revision: 1, created_at: '', updated_at: '', removed_at: null,
    ...overrides,
  }
}

const defaults: MemberDefaults = {
  revision: 2,
  general: { agent_id: 'opencode', config: { model: 'fast' }, instructions: 'Manage the Workspace.' },
  templates: { analysis: 'Analyze.', writing: 'Write.', code_review: 'Review code.' },
}

function api(overrides: Partial<Record<keyof KubecodeApi, unknown>> = {}) {
  return {
    listMembers: vi.fn().mockResolvedValue({ members: [member()], general_id: 'm-general' }),
    ...overrides,
  } as unknown as KubecodeApi
}

function roster(client: KubecodeApi) {
  return render(
    <MemberRoster
      agents={agents}
      api={client}
      connectionState="live"
      defaults={defaults}
      events={[]}
      projectId="p1"
      t={t}
    />,
  )
}

describe('MemberRoster', () => {
  it('offers a private message to active members only', async () => {
    const onOpenDm = vi.fn()
    const client = api({
      listMembers: vi.fn().mockResolvedValue({
        members: [
          member(),
          member({ id: 'm2', role: 'specialist', template: 'analysis', name: 'Analyst', handle: 'analyst', state: 'setup_required' }),
        ],
        general_id: 'm-general',
      }),
    })
    render(
      <MemberRoster
        agents={agents}
        api={client}
        connectionState="live"
        defaults={defaults}
        events={[]}
        projectId="p1"
        t={t}
        onOpenDm={onOpenDm}
      />,
    )
    const button = await screen.findByRole('button', { name: 'kubecode.members.messagePrivately:{"name":"General"}' })
    fireEvent.click(button)
    expect(onOpenDm).toHaveBeenCalledWith(expect.objectContaining({ id: 'm-general' }))
    expect(screen.queryByRole('button', { name: 'kubecode.members.messagePrivately:{"name":"Analyst"}' })).not.toBeInTheDocument()
  })

  it('shows each member in the shared identity, with a membership state only when it needs the researcher', async () => {
    roster(api({
      listMembers: vi.fn().mockResolvedValue({
        members: [
          member(),
          member({ id: 'm2', role: 'specialist', template: 'analysis', name: 'Analyst', handle: 'analyst', state: 'setup_required' }),
        ],
        general_id: 'm-general',
      }),
    }))
    const general = (await screen.findByText('General')).closest('li') as HTMLElement
    expect(within(general).getByText('@general')).toBeInTheDocument()
    expect(within(general).getByText('kubecode.members.template.general')).toBeInTheDocument()
    expect(within(general).getByText('OpenCode')).toBeInTheDocument()
    // Membership is not activity: an active member's row is its identity and provider, with no state at all.
    expect(general).toHaveTextContent(
      /^G\s*General\s*@general\s*kubecode\.members\.template\.general\s*OpenCode\s*kubecode\.members\.managerNote\s*kubecode\.members\.edit\s*kubecode\.members\.replaceSession$/,
    )
    expect(general).not.toHaveTextContent(/kubecode\.members\.state\./)
    const analyst = screen.getByText('Analyst').closest('li') as HTMLElement
    expect(within(analyst).getByText('kubecode.members.state.setup_required')).toBeInTheDocument()
    // Needs you lands on the fix (ADR 0232).
    expect(within(analyst).getByRole('button', { name: 'kubecode.members.retrySetup: Analyst' }))
      .toHaveAttribute('data-focus-key', expect.stringMatching(/^member-setup:/))
  })

  it('shows the project manager as a manager that cannot be removed, beside specialists', async () => {
    roster(api({
      listMembers: vi.fn().mockResolvedValue({
        members: [
          member(),
          member({ id: 'm-a', role: 'specialist', template: 'analysis', name: 'Analyst', handle: 'analyst' }),
        ],
        general_id: 'm-general',
      }),
    }))
    expect(await screen.findByText('General')).toBeInTheDocument()
    expect(screen.getByText('kubecode.members.managerNote')).toBeInTheDocument()
    expect(screen.getByText(/@analyst/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'kubecode.members.remove: General' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'kubecode.members.remove: Analyst' })).toBeInTheDocument()
  })

  it('adds a specialist once per request with the template and its default instructions', async () => {
    const createMember = vi.fn().mockResolvedValue(member({ id: 'm-b', role: 'specialist', name: 'Writer' }))
    roster(api({ createMember }))
    fireEvent.click(await screen.findByRole('button', { name: /kubecode.members.add/ }))
    const form = screen.getByRole('form', { name: 'kubecode.members.add' })
    fireEvent.change(within(form).getByLabelText('kubecode.members.name'), { target: { value: 'Writer' } })
    choose(within(form).getByLabelText('kubecode.members.role'), 'kubecode.members.template.writing')
    expect(within(form).getByLabelText('kubecode.members.instructions')).toHaveValue('Write.')
    fireEvent.click(within(form).getByRole('button', { name: 'kubecode.members.save' }))
    await waitFor(() => expect(createMember).toHaveBeenCalledTimes(1))
    expect(createMember.mock.calls[0][1]).toMatchObject({
      name: 'Writer',
      template: 'writing',
      spec: { agent_id: 'opencode', instructions: 'Write.' },
    })
    expect(createMember.mock.calls[0][1].client_request_id).toBeTruthy()
  })

  it('names a clashing name and a member that still holds work', async () => {
    const createMember = vi.fn().mockRejectedValue(new ApiError('member_name_taken', 'x', 409))
    const removeMember = vi.fn().mockRejectedValue(new ApiError('member_holds_work', 'x', 409))
    roster(api({
      createMember,
      removeMember,
      listMembers: vi.fn().mockResolvedValue({
        members: [member(), member({ id: 'm-a', role: 'specialist', name: 'Analyst', handle: 'analyst' })],
        general_id: 'm-general',
      }),
    }))
    fireEvent.click(await screen.findByRole('button', { name: /kubecode.members.add/ }))
    const form = screen.getByRole('form', { name: 'kubecode.members.add' })
    fireEvent.change(within(form).getByLabelText('kubecode.members.name'), { target: { value: 'Analyst' } })
    fireEvent.click(within(form).getByRole('button', { name: 'kubecode.members.save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('kubecode.members.error.nameTaken')
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.members.remove: Analyst' }))
    // Removing asks once more before it does anything.
    expect(removeMember).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.members.confirmRemove: Analyst' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('kubecode.members.error.holdsWork'))
  })

  it('shows a setup problem on the member and retries it on request', async () => {
    const retryMemberSetup = vi.fn().mockResolvedValue(member())
    roster(api({
      retryMemberSetup,
      listMembers: vi.fn().mockResolvedValue({
        members: [member({
          state: 'setup_required', public_conversation_id: null,
          setup_error: 'opencode is not installed or available on this server', setup_code: 'provider_unavailable',
        })],
        general_id: 'm-general',
      }),
    }))
    // The reason is worded in the browser's language from the code, not shown as server text.
    expect(await screen.findByText(/kubecode.members.setup.providerUnavailable/)).toBeInTheDocument()
    expect(screen.queryByText(/not installed or available on this server/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.members.retrySetup: General' }))
    await waitFor(() => expect(retryMemberSetup).toHaveBeenCalledWith('p1', 'm-general'))
  })

  it('locks the provider of a member that already has a Session and sends the revision on edit', async () => {
    const updateMember = vi.fn().mockResolvedValue(member())
    roster(api({
      updateMember,
      listMembers: vi.fn().mockResolvedValue({ members: [member({ revision: 4 })], general_id: 'm-general' }),
    }))
    fireEvent.click(await screen.findByRole('button', { name: 'kubecode.members.edit: General' }))
    const form = screen.getByRole('form', { name: 'kubecode.members.edit' })
    expect(within(form).getByLabelText('kubecode.members.provider')).toBeDisabled()
    expect(within(form).queryByLabelText('kubecode.members.role')).not.toBeInTheDocument()
    fireEvent.change(within(form).getByLabelText('kubecode.members.name'), { target: { value: 'Project Lead' } })
    fireEvent.click(within(form).getByRole('button', { name: 'kubecode.members.save' }))
    await waitFor(() => expect(updateMember).toHaveBeenCalled())
    expect(updateMember.mock.calls[0].slice(0, 3)).toEqual(['p1', 'm-general', 4])
    expect(updateMember.mock.calls[0][3]).toMatchObject({ name: 'Project Lead' })
    expect(updateMember.mock.calls[0][3].template).toBeUndefined()
  })

  it('says so when the roster cannot be loaded', async () => {
    roster(api({ listMembers: vi.fn().mockRejectedValue(new Error('down')) }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('kubecode.members.loadFailed')
    expect(alert).toHaveAttribute('data-slot', 'alert')
  })
})

describe('MemberRoster review regressions', () => {
  it('replaces a Session with the chosen provider and explains what that does', async () => {
    const replaceMemberSession = vi.fn().mockResolvedValue(member())
    roster(api({ replaceMemberSession }))
    fireEvent.click(await screen.findByRole('button', { name: 'kubecode.members.replaceSession: General' }))
    const form = screen.getByRole('form', { name: 'kubecode.members.replaceSession' })
    expect(within(form).getByText('kubecode.members.replaceHelp')).toBeInTheDocument()
    fireEvent.click(within(form).getByRole('button', { name: 'kubecode.members.replaceConfirm' }))
    await waitFor(() => expect(replaceMemberSession).toHaveBeenCalledWith('p1', 'm-general', {
      agent_id: 'opencode', config: {}, instructions: 'Manage.',
    }))
  })

  it('keeps one request id for a retried add and drops a form built from a stale revision', async () => {
    const createMember = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(member({ id: 'm-b', role: 'specialist', name: 'Writer' }))
    const updateMember = vi.fn().mockRejectedValue(new ApiError('member_revision_conflict', 'x', 409))
    const listMembers = vi.fn().mockResolvedValue({ members: [member({ revision: 2 })], general_id: 'm-general' })
    roster(api({ createMember, updateMember, listMembers }))
    fireEvent.click(await screen.findByRole('button', { name: /kubecode.members.add/ }))
    let form = screen.getByRole('form', { name: 'kubecode.members.add' })
    fireEvent.change(within(form).getByLabelText('kubecode.members.name'), { target: { value: 'Writer' } })
    fireEvent.click(within(form).getByRole('button', { name: 'kubecode.members.save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('network down')
    form = screen.getByRole('form', { name: 'kubecode.members.add' })
    fireEvent.click(within(form).getByRole('button', { name: 'kubecode.members.save' }))
    await waitFor(() => expect(createMember).toHaveBeenCalledTimes(2))
    expect(createMember.mock.calls[0][1].client_request_id).toBe(createMember.mock.calls[1][1].client_request_id)

    fireEvent.click(await screen.findByRole('button', { name: 'kubecode.members.edit: General' }))
    form = screen.getByRole('form', { name: 'kubecode.members.edit' })
    fireEvent.click(within(form).getByRole('button', { name: 'kubecode.members.save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('kubecode.members.error.stale')
    // The stale form is gone and the roster was read again.
    await waitFor(() => expect(screen.queryByRole('form', { name: 'kubecode.members.edit' })).not.toBeInTheDocument())
    expect(listMembers.mock.calls.length).toBeGreaterThan(1)
  })

  it('does not overwrite instructions the researcher edited when the template changes', async () => {
    roster(api())
    fireEvent.click(await screen.findByRole('button', { name: /kubecode.members.add/ }))
    const form = screen.getByRole('form', { name: 'kubecode.members.add' })
    const instructions = within(form).getByLabelText('kubecode.members.instructions')
    choose(within(form).getByLabelText('kubecode.members.role'), 'kubecode.members.template.writing')
    expect(instructions).toHaveValue('Write.')
    fireEvent.change(instructions, { target: { value: 'My own words' } })
    choose(within(form).getByLabelText('kubecode.members.role'), 'kubecode.members.template.code_review')
    expect(instructions).toHaveValue('My own words')
  })

  it('offers to try again when the roster cannot be loaded and says when a refresh failed', async () => {
    const listMembers = vi.fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue({ members: [member()], general_id: 'm-general' })
    roster(api({ listMembers }))
    expect(await screen.findByRole('alert')).toHaveTextContent('kubecode.members.loadFailed')
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.members.retryLoad' }))
    expect(await screen.findByText('General')).toBeInTheDocument()
  })
})

describe('MemberDefaultsPanel', () => {
  it('edits the server defaults with their revision and says a stale save was refused', async () => {
    const saveMemberDefaults = vi.fn()
      .mockRejectedValueOnce(new ApiError('member_revision_conflict', 'x', 409))
      .mockResolvedValue({ ...defaults, revision: 3 })
    const memberDefaults = vi.fn().mockResolvedValue(defaults)
    render(<MemberDefaultsPanel agents={agents} api={{ memberDefaults, saveMemberDefaults } as unknown as KubecodeApi} t={t} />)
    fireEvent.change(await screen.findByLabelText('kubecode.members.defaults.generalInstructions'), {
      target: { value: 'New instructions' },
    })
    fireEvent.change(screen.getByLabelText('kubecode.members.defaults.configValue 1'), { target: { value: 'slow' } })
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.members.save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('kubecode.members.error.stale')
    expect(saveMemberDefaults.mock.calls[0][0]).toBe(2)
    expect(saveMemberDefaults.mock.calls[0][1].general).toEqual({
      agent_id: 'opencode',
      config: { model: 'slow' },
      instructions: 'New instructions',
    })
    await waitFor(() => expect(memberDefaults).toHaveBeenCalledTimes(2))
    // What was typed is kept; the next save uses the newer revision.
    expect(screen.getByLabelText('kubecode.members.defaults.generalInstructions')).toHaveValue('New instructions')
  })

  it('does not offer an option row without a key and value, and keeps the manager boundary visible', async () => {
    const saveMemberDefaults = vi.fn().mockResolvedValue({ ...defaults, revision: 3 })
    render(<MemberDefaultsPanel
      agents={agents}
      api={{ memberDefaults: vi.fn().mockResolvedValue(defaults), saveMemberDefaults } as unknown as KubecodeApi}
      t={t}
    />)
    expect(await screen.findByText('kubecode.members.defaults.boundary')).toBeInTheDocument()
    // Nothing changed yet: nothing to save, and a blank option row is no change.
    expect(screen.getByRole('button', { name: 'kubecode.members.save' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /kubecode.members.defaults.addConfig/ }))
    expect(screen.getByRole('button', { name: 'kubecode.members.save' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('kubecode.members.defaults.generalInstructions'), { target: { value: 'Plan.' } })
    expect(screen.getByText('kubecode.members.defaults.unsaved')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.members.save' }))
    await waitFor(() => expect(saveMemberDefaults).toHaveBeenCalled())
    expect(saveMemberDefaults.mock.calls[0][1].general.config).toEqual({ model: 'fast' })
    expect(await screen.findByText('kubecode.members.defaults.saved')).toBeInTheDocument()
  })
})

describe('MemberDefaultsPanel and the locked manager (ADR 0226)', () => {
  it('refuses a mode option for the project manager before it reaches the server', async () => {
    const saveMemberDefaults = vi.fn()
    render(<MemberDefaultsPanel
      agents={agents}
      api={{ memberDefaults: vi.fn().mockResolvedValue(defaults), saveMemberDefaults } as unknown as KubecodeApi}
      t={t}
    />)
    fireEvent.change(await screen.findByLabelText('kubecode.members.defaults.configKey 1'), { target: { value: 'mode' } })
    expect(screen.getByRole('alert')).toHaveTextContent('kubecode.members.defaults.modeLocked:{"key":"mode"}')
    expect(screen.getByLabelText('kubecode.members.defaults.configKey 1')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('kubecode.members.defaults.configKey 1')).toHaveAccessibleDescription('kubecode.members.defaults.modeLocked:{"key":"mode"}')
    expect(screen.getByRole('button', { name: 'kubecode.members.save' })).toBeDisabled()
    // Discarding returns to what was saved.
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.members.cancel' }))
    expect(screen.getByLabelText('kubecode.members.defaults.configKey 1')).toHaveValue('model')
    expect(saveMemberDefaults).not.toHaveBeenCalled()
  })
})

describe('MembersView', () => {
  it('keeps current members and the defaults for new members apart', async () => {
    const memberDefaults = vi.fn().mockResolvedValue(defaults)
    const onDefaultsLoaded = vi.fn()
    render(
      <MembersView
        agents={agents}
        api={api({ memberDefaults })}
        connectionState="live"
        defaults={null}
        events={[]}
        projectId="p1"
        t={t}
        onDefaultsLoaded={onDefaultsLoaded}
        onOpenDm={vi.fn()}
        onOpenMember={vi.fn()}
      />,
    )
    expect(await screen.findByRole('tab', { name: 'kubecode.members.tabs.current', selected: true })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'kubecode.members.current.title' })).toBeInTheDocument()
    expect(screen.queryByLabelText('kubecode.members.defaults.generalInstructions')).not.toBeInTheDocument()
    // The add form is pre-filled from the defaults even before their tab is opened.
    await waitFor(() => expect(onDefaultsLoaded).toHaveBeenCalledWith(defaults))
    const tab = screen.getByRole('tab', { name: 'kubecode.members.tabs.defaults' })
    fireEvent.mouseDown(tab)
    fireEvent.click(tab)
    expect(await screen.findByLabelText('kubecode.members.defaults.generalInstructions')).toHaveValue('Manage the Workspace.')
    expect(screen.queryByRole('heading', { name: 'kubecode.members.current.title' })).not.toBeInTheDocument()
  })

  it('shows what a member is executing apart from its membership, and opens the profile and edit in place', async () => {
    const onOpenMember = vi.fn()
    const analyst = member({ id: 'm2', role: 'specialist', template: 'analysis', name: 'Analyst', handle: 'analyst', public_conversation_id: 's2' })
    render(
      <MemberRoster
        agents={agents}
        api={api({ listMembers: vi.fn().mockResolvedValue({ members: [member(), analyst], general_id: 'm-general' }) })}
        connectionState="live"
        defaults={defaults}
        events={[]}
        projectId="p1"
        sessions={[{ id: 's2', latest_run_status: 'running' }] as never}
        t={t}
        onOpenMember={onOpenMember}
      />,
    )
    const row = (await screen.findByText('Analyst')).closest('li') as HTMLElement
    // Each member is a shadcn Item (ADR 0244).
    expect(row).toHaveAttribute('data-slot', 'item')
    expect(within(row).getByText('kubecode.members.activity.running')).toBeInTheDocument()
    expect(within(row).queryByText(/kubecode\.members\.state\./)).not.toBeInTheDocument()
    fireEvent.click(within(row).getByRole('button', { name: 'kubecode.members.openProfile:{"name":"Analyst"}' }))
    expect(onOpenMember).toHaveBeenCalledWith(analyst)
    fireEvent.click(within(row).getByRole('button', { name: 'kubecode.members.edit: Analyst' }))
    expect(within(row).getByRole('form', { name: 'kubecode.members.edit' })).toBeInTheDocument()
    // The project manager's responsibility and restrictions are shown locked.
    const general = screen.getByText('General').closest('li') as HTMLElement
    fireEvent.click(within(general).getByRole('button', { name: 'kubecode.members.edit: General' }))
    expect(within(general).getByRole('note')).toHaveTextContent('kubecode.members.managerLocked')
    expect(within(general).queryByLabelText('kubecode.members.role')).not.toBeInTheDocument()
    expect(within(general).getByLabelText('kubecode.members.provider')).toBeDisabled()
  })
})

describe('MembersView keeps its place (ADR 0228 §4)', () => {
  it('returns to where the roster was scrolled, and names each member for focus return', async () => {
    const restore = stubScrollGeometry()
    try {
      const memory = createPlaceMemory()
      const client = api({ memberDefaults: vi.fn().mockResolvedValue(defaults) })
      const members = (
        <PlaceMemoryProvider memory={memory}>
          <MembersView
            agents={agents}
            api={client}
            connectionState="live"
            defaults={defaults}
            events={[]}
            projectId="p1"
            scrollKey="p1|view:members"
            t={t}
            onDefaultsLoaded={vi.fn()}
            onOpenDm={vi.fn()}
            onOpenMember={vi.fn()}
          />
        </PlaceMemoryProvider>
      )
      const view = render(members)
      const name = await screen.findByRole('button', { name: 'General' })
      const row = name.closest('li')
      expect(row).toHaveAttribute('data-focus-key', 'member:m-general')
      expect(row).toHaveAttribute('data-scroll-anchor', 'member:m-general')
      const scroller = screen.getByRole('region', { name: 'kubecode.nav.members' })
      scroller.scrollTop = 310
      fireEvent.scroll(scroller)
      await act(nextFrame)

      view.rerender(<PlaceMemoryProvider memory={memory}><p>General</p></PlaceMemoryProvider>)
      view.rerender(members)
      await screen.findByRole('button', { name: 'General' })
      await waitFor(() => expect(screen.getByRole('region', { name: 'kubecode.nav.members' }).scrollTop).toBe(310))
    } finally {
      restore()
    }
  })
})
