import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { AgentDescriptor, KubecodeApi, Member } from '../api'
import { DEFAULT_KUBECODE_AGENT_PREFERENCES } from '../agentPreferences'
import { SettingsDialog, type SettingsDialogProps } from './SettingsDialog'

const t = ((key: string) => key) as never

const general: Member = {
  id: 'm1', project_id: 'p1', role: 'general', template: 'general', name: 'General', handle: 'general',
  spec: { agent_id: 'opencode', config: {}, instructions: '' }, public_conversation_id: 's1',
  dm_conversation_id: null, state: 'active', setup_error: null, setup_code: null, revision: 1,
  created_at: '', updated_at: '', removed_at: null,
}

function dialog(overrides: Partial<SettingsDialogProps> = {}, api: Partial<Record<keyof KubecodeApi, unknown>> = {}) {
  const client = {
    listMembers: vi.fn().mockResolvedValue({ members: [general], general_id: 'm1' }),
    memberDefaults: vi.fn().mockResolvedValue({
      revision: 0,
      general: { agent_id: 'opencode', config: {}, instructions: 'Manage.' },
      templates: {},
    }),
    ...api,
  } as unknown as KubecodeApi
  const props = {
    api: client,
    agentPreferences: DEFAULT_KUBECODE_AGENT_PREFERENCES,
    agents: [{ id: 'opencode', available: true }] as unknown as AgentDescriptor[],
    agentsRefreshing: false,
    appearance: {},
    editorPreferences: {},
    notifications: {},
    notificationPermission: 'default',
    notificationTestStatus: null,
    open: true,
    requestedSection: 'members',
    onAppearanceChange: vi.fn(),
    onAgentPreferencesChange: vi.fn(),
    onEditorPreferencesChange: vi.fn(),
    onNotificationsChange: vi.fn(),
    onOpenChange: vi.fn(),
    onRequestNotificationPermission: vi.fn(),
    onRefreshAgents: vi.fn(),
    onTestNotification: vi.fn(),
    t,
    ...overrides,
  } as unknown as SettingsDialogProps
  return { client, ...render(<SettingsDialog {...props} />) }
}

describe('Settings > Members', () => {
  it('shows the selected Workspace roster beside the server defaults', async () => {
    const { client } = dialog({ activeProjectId: 'p1' })
    expect(await screen.findByText('General')).toBeInTheDocument()
    expect(client.listMembers).toHaveBeenCalledWith('p1')
    expect(await screen.findByLabelText('kubecode.members.defaults.generalInstructions')).toHaveValue('Manage.')
    expect(screen.getByRole('button', { name: 'kubecode.members.title' })).toBeInTheDocument()
  })

  it('asks for a Workspace when none is selected and still offers the defaults', async () => {
    const { client } = dialog({ activeProjectId: null })
    expect(screen.getByText('kubecode.members.noProject')).toBeInTheDocument()
    expect(client.listMembers).not.toHaveBeenCalled()
    expect(await screen.findByLabelText('kubecode.members.defaults.generalInstructions')).toBeInTheDocument()
  })

  it('is reachable from the settings navigation', async () => {
    dialog({ activeProjectId: 'p1', requestedSection: 'general' })
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.members.title' }))
    expect(await screen.findByText('General')).toBeInTheDocument()
  })
})
