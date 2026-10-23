import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { AgentDescriptor, KubecodeApi, Member } from '../api'
import { DEFAULT_KUBECODE_AGENT_PREFERENCES } from '../agentPreferences'
import { DEFAULT_KUBECODE_NOTIFICATIONS } from '../notificationPreferences'
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
    notifications: DEFAULT_KUBECODE_NOTIFICATIONS,
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
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'kubecode.settings.memberDefaults' }))
    expect(await screen.findByLabelText('kubecode.members.defaults.generalInstructions')).toBeInTheDocument()
  })
})

describe('Settings forms', () => {
  it('lists sections as tabs and selects the requested one', () => {
    dialog({ requestedSection: 'general' })
    expect(screen.getByRole('tab', { name: 'kubecode.settings.general' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'kubecode.settings.notifications' }))
    expect(screen.getByRole('tab', { name: 'kubecode.settings.notifications' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { name: 'kubecode.settings.notifications', level: 2 })).toBeInTheDocument()
  })

  it('labels and describes each setting through its field', () => {
    dialog({
      requestedSection: 'general',
      appearance: { colorScheme: 'system', theme: 'system', uiFont: 'Inter', uiFontSize: 14, codeFont: '', terminalFont: '' },
    } as never)
    expect(screen.getByRole('combobox', { name: 'kubecode.colorScheme' })).toHaveAccessibleDescription('kubecode.colorSchemeDescription')
    expect(screen.getByRole('textbox', { name: 'kubecode.uiFont' })).toHaveAccessibleDescription('kubecode.uiFontDescription')
  })

  it('collapses each agent diagnosis into a disclosure', () => {
    dialog({
      requestedSection: 'agents',
      agents: [{ id: 'codex', available: true, version: '1.0' }] as unknown as AgentDescriptor[],
    }, { runtimeStatus: vi.fn(() => new Promise(() => undefined)) })
    const trigger = screen.getByRole('button', { name: /Codex/ })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('kubecode.authenticationCheckedOnSession')).toBeVisible()
    expect(screen.getByTestId('runtime-status-panel')).toHaveTextContent('kubecode.runtimeStatusLoading')
  })

  it('lists sections above the content on a phone and beside it on a wide screen', () => {
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia
    try {
      dialog({ requestedSection: 'general' })
      const tablist = screen.getByRole('tablist')
      expect(tablist).toHaveAttribute('aria-orientation', 'horizontal')
      // The close button sits in its own column beside the scrolling strip, never over it.
      const closes = screen.getAllByRole('button', { name: /close/i })
      expect(closes).toHaveLength(1)
      expect(closes[0].parentElement).toBe(tablist.parentElement)
      expect(tablist).toHaveClass('min-w-0', 'flex-1')
      expect(tablist).not.toHaveClass('pr-12')
    } finally {
      window.matchMedia = original
    }
  })

  it('shows the terminal section as an empty state', () => {
    dialog({ requestedSection: 'terminal' })
    expect(screen.getByText('kubecode.settingsComingSoon').closest('[data-slot="empty"]')).not.toBeNull()
  })
})
