import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { AgentDescriptor, KubecodeApi, Member, MemberDefaults } from '../api'
import { ApiError } from '../api'
import { MemberDefaultsPanel } from './MemberDefaultsPanel'
import { MemberRoster } from './MemberRoster'

const t = ((key: string, values?: Record<string, string | number>) => (
  values ? `${key}:${JSON.stringify(values)}` : key
)) as never

const agents = [
  { id: 'opencode', available: true },
  { id: 'codex', available: false },
] as unknown as AgentDescriptor[]

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
    fireEvent.change(within(form).getByLabelText('kubecode.members.role'), { target: { value: 'writing' } })
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
    expect(await screen.findByRole('alert')).toHaveTextContent('kubecode.members.loadFailed')
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
    fireEvent.change(within(form).getByLabelText('kubecode.members.role'), { target: { value: 'writing' } })
    expect(instructions).toHaveValue('Write.')
    fireEvent.change(instructions, { target: { value: 'My own words' } })
    fireEvent.change(within(form).getByLabelText('kubecode.members.role'), { target: { value: 'code_review' } })
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
    fireEvent.click(screen.getByRole('button', { name: /kubecode.members.defaults.addConfig/ }))
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.members.save' }))
    await waitFor(() => expect(saveMemberDefaults).toHaveBeenCalled())
    expect(saveMemberDefaults.mock.calls[0][1].general.config).toEqual({ model: 'fast' })
    expect(await screen.findByText('kubecode.members.defaults.saved')).toBeInTheDocument()
  })
})
