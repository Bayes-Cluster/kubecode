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

describe('Settings > Agent defaults', () => {
  it('holds the defaults for new members only, and leads to the selected Workspace\'s members', async () => {
    const onOpenWorkspaceMembers = vi.fn()
    const { client } = dialog({ activeProjectId: 'p1', onOpenWorkspaceMembers })
    expect(screen.getByRole('heading', { name: 'kubecode.settings.memberDefaults', level: 2 })).toBeInTheDocument()
    expect(await screen.findByLabelText('kubecode.members.defaults.generalInstructions')).toHaveValue('Manage.')
    // Current members are not edited here, so the two are never confused.
    expect(client.listMembers).not.toHaveBeenCalled()
    expect(screen.queryByText('General')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.settings.openWorkspaceMembers' }))
    expect(onOpenWorkspaceMembers).toHaveBeenCalled()
  })

  it('asks for a Workspace when none is selected and still offers the defaults', async () => {
    dialog({ activeProjectId: null, onOpenWorkspaceMembers: vi.fn() })
    expect(screen.getByText('kubecode.members.noProject')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'kubecode.settings.openWorkspaceMembers' })).not.toBeInTheDocument()
    expect(await screen.findByLabelText('kubecode.members.defaults.generalInstructions')).toBeInTheDocument()
  })

  it('is reachable from the settings navigation', async () => {
    dialog({ activeProjectId: 'p1', requestedSection: 'general' })
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.settings.memberDefaults' }))
    expect(await screen.findByLabelText('kubecode.members.defaults.generalInstructions')).toBeInTheDocument()
  })
})
