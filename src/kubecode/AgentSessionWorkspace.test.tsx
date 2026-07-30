import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AiAgentMessage } from '@/lib/aiAgentConversation'
import { createTranslator } from '@/lib/i18n'
import { trackEvent } from '@/lib/telemetry'

import { AgentSessionWorkspace } from './AgentSessionWorkspace'
import {
  ApiError,
  type AgentRun,
  type KubecodeApi,
  type TeamSnapshot,
  type WorkspaceEvent,
} from './api'

vi.mock('@/components/AiPanelChrome', () => ({
  AiPanelMessageHistory: ({ leadingContent, messages, onEditMessage, onRegenerateMessage }: {
    leadingContent?: ReactNode
    messages: AiAgentMessage[]
    onEditMessage?: (messageId: string, message: string) => void
    onRegenerateMessage?: (messageId: string) => void
  }) => (
    <div data-testid="message-history">{leadingContent}{messages.map((message) => (
      <article key={message.id} data-streaming={message.isStreaming}>
        {message.userMessage}
        {message.reasoning}
        {message.response}
        {message.responseBlocks?.map((block) => (
          <span data-testid="response-block" key={block.id}>{block.text}</span>
        ))}
        {message.actions.map((action) => (
          <span key={action.toolId}>{action.label}:{action.status}:{action.output}</span>
        ))}
        {message.id && onEditMessage && (
          <button onClick={() => onEditMessage(message.id as string, message.userMessage)}>Edit message</button>
        )}
        {message.id && onRegenerateMessage && (
          <button onClick={() => onRegenerateMessage(message.id as string)}>Regenerate response</button>
        )}
      </article>
    ))}</div>
  ),
  AiPanelComposer: ({ activeSendLabel, controls, disabled, disabledPlaceholder, input, inputContent, isActive, leadingControl, onActiveSend, onChange, onSend, onStop, sendDisabled }: {
    activeSendLabel?: string
    controls?: ReactNode
    disabled?: boolean
    disabledPlaceholder?: string
    input: string
    inputContent?: ReactNode
    isActive: boolean
    leadingControl?: ReactNode
    onActiveSend?: (text: string, references: []) => void
    onChange: (value: string) => void
    onSend: (text: string, references: []) => void
    onStop: () => void
    sendDisabled?: boolean
  }) => (
    <div
      data-disabled={disabled}
      data-disabled-placeholder={disabledPlaceholder}
      data-testid="composer"
    >
      {leadingControl}{controls}{inputContent}
      <span data-testid="composer-draft">{input}</span>
      <button disabled={disabled} onClick={() => onChange('Prepared follow-up')}>Type follow-up</button>
      {!isActive && (
        <button aria-label="Send composer" disabled={disabled || sendDisabled} onClick={() => onSend(input, [])}>
          Send
        </button>
      )}
      {onActiveSend && (
        <button aria-label={activeSendLabel} onClick={() => onActiveSend(input, [])}>Send active</button>
      )}
      {isActive && <button onClick={onStop}>Stop Agent</button>}
    </div>
  ),
}))

vi.mock('@/lib/telemetry', () => ({ trackEvent: vi.fn() }))

afterEach(() => {
  globalThis.sessionStorage?.clear()
  vi.mocked(trackEvent).mockClear()
})

const conversation = {
  id: 'session-1',
  project_id: 'project-1',
  agent_id: 'codex' as const,
  provider_session_id: 'provider-1',
  title: 'Build feature',
  manual_title: null,
  agent_title: 'Build feature',
}

const emptySessionState = {
  capabilities: null,
  available_commands: null,
  current_mode: null,
  config_options: null,
  plan: null,
  usage: null,
}

const run: AgentRun = {
  id: 'run-1',
  conversation_id: conversation.id,
  project_id: conversation.project_id,
  message: 'Implement it',
  status: 'completed',
  permission_mode: 'safe',
  error: null,
}

describe('AgentSessionWorkspace', () => {
  it('guides an empty project through Agent readiness without creating a diagnostic Session', () => {
    const onNewSession = vi.fn()
    const onRefreshAgents = vi.fn().mockResolvedValue(undefined)
    render(<AgentSessionWorkspace
      agents={[
        { id: 'codex', available: true, version: '1', executable: 'codex', error: null },
        { id: 'opencode', available: false, version: null, executable: 'opencode', error: 'missing' },
      ]}
      api={{} as KubecodeApi}
      conversation={null}
      locale="en"
      onConversationCreated={vi.fn()}
      onConversationRemoved={vi.fn()}
      onConversationUpdated={vi.fn()}
      onNewSession={onNewSession}
      onRefreshAgents={onRefreshAgents}
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    expect(screen.getByText('Codex')).toBeInTheDocument()
    expect(screen.getByText('OpenCode')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Start an agent session' }))
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(onNewSession).toHaveBeenCalledOnce()
    expect(onRefreshAgents).toHaveBeenCalledOnce()
  })

  it('keeps the Agent Composer out of the Team board view', async () => {
    const leader = { ...conversation, team_id: 'team-1', team_role: 'leader' as const }
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue(emptySessionState),
    } as unknown as KubecodeApi
    const team = {
      team: { id: 'team-1', status: 'active', title: 'Research team' },
      leader_conversation: leader,
      conversations: [leader],
      members: [{ id: 'member-leader', conversation_id: leader.id, role: 'leader' }],
      tasks: [],
    } as unknown as TeamSnapshot

    render(<AgentSessionWorkspace
      agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
      api={api}
      conversation={leader}
      locale="en"
      onConversationCreated={vi.fn()}
      onConversationRemoved={vi.fn()}
      onConversationUpdated={vi.fn()}
      projectId="project-1"
      t={createTranslator('en')}
      team={team}
      workspaceEvents={[]}
    />)

    expect(screen.getByRole('tab', { name: 'Team' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByTestId('composer')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }))
    expect(await screen.findByTestId('composer')).toBeInTheDocument()
  })

  it('confirms deleting a Team Leader before deleting every member', async () => {
    const leader = { ...conversation, team_id: 'team-1', team_role: 'leader' as const }
    const teammate = { ...conversation, id: 'session-2', title: 'Reviewer' }
    const deleteConversation = vi.fn().mockResolvedValue(undefined)
    const onConversationRemoved = vi.fn()
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue(emptySessionState),
      deleteConversation,
    } as unknown as KubecodeApi
    const team = {
      team: { id: 'team-1', title: 'Research team' },
      leader_conversation: leader,
      conversations: [leader, teammate],
      members: [
        { id: 'member-leader', conversation_id: leader.id, role: 'leader' },
        { id: 'member-reviewer', conversation_id: teammate.id, role: 'teammate' },
      ],
      tasks: [],
    } as unknown as TeamSnapshot

    render(<AgentSessionWorkspace
      agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
      api={api}
      conversation={leader}
      locale="en"
      onConversationCreated={vi.fn()}
      onConversationRemoved={onConversationRemoved}
      onConversationUpdated={vi.fn()}
      projectId="project-1"
      t={createTranslator('en')}
      team={team}
      workspaceEvents={[]}
    />)

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Session actions' }), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    })
    fireEvent.click(await screen.findByText('Delete'))

    expect(deleteConversation).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Delete Research team?' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(deleteConversation).toHaveBeenCalledWith(leader.id))
    expect(onConversationRemoved).toHaveBeenCalledWith(leader.id)
    expect(onConversationRemoved).toHaveBeenCalledWith(teammate.id)
  })

  it('does not expose direct deletion for a Team teammate', async () => {
    const teammate = { ...conversation, team_id: 'team-1', team_role: 'teammate' as const }
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue(emptySessionState),
      deleteConversation: vi.fn(),
    } as unknown as KubecodeApi

    render(<AgentSessionWorkspace
      agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
      api={api}
      conversation={teammate}
      locale="en"
      onConversationCreated={vi.fn()}
      onConversationRemoved={vi.fn()}
      onConversationUpdated={vi.fn()}
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Session actions' }), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    })

    expect(screen.queryByText('Delete')).not.toBeInTheDocument()
  })

  it('places Agent skills, commands, and project files behind the Composer add button', async () => {
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue({
        ...emptySessionState,
        available_commands: {
          availableCommands: [{ name: 'review', description: 'Review changes' }],
        },
      }),
    } as unknown as KubecodeApi

    render(<AgentSessionWorkspace
      agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
      api={api}
      conversation={conversation}
      locale="en"
      onConversationCreated={vi.fn()}
      onConversationRemoved={vi.fn()}
      onConversationUpdated={vi.fn()}
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    expect(await screen.findByRole('button', { name: 'Add context' })).toBeInTheDocument()
  })

  it('submits a capability chip as an opaque structured reference without analytics names', async () => {
    const catalog = {
      conversation_id: 'session-1', revision: 6, contexts: [],
      items: [{
        id: 'cap:project:review', kind: 'skill' as const, name: 'review',
        description: 'Review changes', source_label: 'Project skill', scope: 'project' as const,
        input_hint: null, enabled: true, disabled_reason: null,
      }],
    }
    const startStructuredRun = vi.fn().mockResolvedValue({
      ...run, id: 'capability-run', message: '$review', status: 'running',
    })
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      listConversationRevisions: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue({ ...emptySessionState, composer: { catalog } }),
      startStructuredRun,
    } as unknown as KubecodeApi

    render(<AgentSessionWorkspace
      agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
      api={api}
      conversation={conversation}
      locale="en"
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add context' }))
    fireEvent.click(await screen.findByRole('option', { name: /\$review/i }))
    expect(await screen.findByTestId('composer-context-chip')).toHaveTextContent('Project skill')
    fireEvent.click(screen.getByRole('button', { name: 'Send composer' }))

    await waitFor(() => expect(startStructuredRun).toHaveBeenCalledWith(
      'project-1',
      'session-1',
      {
        catalog_revision: 6,
        segments: [
          { kind: 'capability_ref', id: 'cap:project:review', catalog_revision: 6, item_kind: 'skill' },
          { kind: 'text', text: ' ' },
        ],
      },
    ))
    const insertionEvent = vi.mocked(trackEvent).mock.calls.find(([name]) => (
      name === 'kubecode_agent_context_inserted'
    ))
    expect(insertionEvent).toEqual([
      'kubecode_agent_context_inserted',
      { agent_id: 'codex', kind: 'skill' },
    ])
    expect(JSON.stringify(insertionEvent)).not.toContain('review')
    expect(JSON.stringify(insertionEvent)).not.toContain('cap:')
  })

  it('submits a Git diff chip without putting filenames or revisions in analytics', async () => {
    const sourceRevision = 'a'.repeat(64)
    const catalog = {
      conversation_id: 'session-1', revision: 7, items: [],
      contexts: [{
        id: 'ctx:git:revision', kind: 'git_diff' as const, display: 'src/private.ts',
        enabled: true, disabled_reason: null,
        summary: {
          kind: 'git_diff' as const, scope: 'file' as const,
          file_count: 1, hunk_count: 2, byte_count: 512,
        },
      }],
    }
    const startStructuredRun = vi.fn().mockResolvedValue({
      ...run, id: 'git-run', message: '@src/private.ts', status: 'running',
    })
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      listConversationRevisions: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue({
        ...emptySessionState,
        composer: { catalog: { conversation_id: 'session-1', revision: 0, items: [], contexts: [] } },
      }),
      listComposerGitDiffs: vi.fn().mockResolvedValue({
        is_repository: true,
        candidates: [{
          path: 'src/private.ts', source_revision: sourceRevision, file_count: 1,
          hunk_count: 2, byte_count: 512, enabled: true, disabled_reason: null,
        }],
      }),
      registerComposerContext: vi.fn().mockResolvedValue({
        context: catalog.contexts[0], catalog,
      }),
      startStructuredRun,
    } as unknown as KubecodeApi

    render(<AgentSessionWorkspace
      agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
      api={api}
      conversation={conversation}
      locale="en"
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add context' }))
    fireEvent.click(screen.getByRole('button', { name: /Reference Git changes/i }))
    fireEvent.click(await screen.findByRole('button', { name: /private\.ts/i }))
    expect(await screen.findByTestId('composer-context-chip')).toHaveAttribute(
      'data-context-kind',
      'git_diff',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Send composer' }))

    await waitFor(() => expect(startStructuredRun).toHaveBeenCalledWith(
      'project-1',
      'session-1',
      {
        catalog_revision: 7,
        segments: [
          {
            kind: 'context_ref', id: 'ctx:git:revision', catalog_revision: 7,
            context_kind: 'git_diff',
          },
          { kind: 'text', text: ' ' },
        ],
      },
    ))
    const insertionEvent = vi.mocked(trackEvent).mock.calls.find(([name, properties]) => (
      name === 'kubecode_agent_context_inserted'
        && properties?.kind === 'git_diff'
    ))
    expect(insertionEvent).toEqual([
      'kubecode_agent_context_inserted',
      { agent_id: 'codex', kind: 'git_diff' },
    ])
    expect(JSON.stringify(insertionEvent)).not.toContain('private.ts')
    expect(JSON.stringify(insertionEvent)).not.toContain(sourceRevision)
  })

  it('submits an explicit terminal selection without leaking content or terminal identity to analytics', async () => {
    const privateSelection = 'npm test /private/project/secret.ts'
    const catalog = {
      conversation_id: 'session-1', revision: 8, items: [],
      contexts: [{
        id: 'ctx:terminal:opaque', kind: 'terminal' as const, display: 'terminal',
        enabled: true, disabled_reason: null,
        summary: {
          kind: 'terminal' as const, capture: 'selection' as const, pane_index: 1,
          line_count: 1, byte_count: 35, truncated: false,
        },
      }],
    }
    const startStructuredRun = vi.fn().mockResolvedValue({
      ...run, id: 'terminal-run', message: '@terminal', status: 'running',
    })
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      listConversationRevisions: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue({
        ...emptySessionState,
        composer: { catalog: { conversation_id: 'session-1', revision: 0, items: [], contexts: [] } },
      }),
      registerComposerContext: vi.fn().mockResolvedValue({
        context: catalog.contexts[0], catalog,
      }),
      startStructuredRun,
    } as unknown as KubecodeApi

    render(<AgentSessionWorkspace
      agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
      api={api}
      conversation={conversation}
      locale="en"
      projectId="project-1"
      t={createTranslator('en')}
      terminalContextSources={[{
        terminalId: 'terminal-private-id', paneIndex: 1, selectedText: privateSelection,
      }]}
      workspaceEvents={[]}
    />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add context' }))
    fireEvent.click(screen.getByRole('button', { name: /Reference terminal output/i }))
    fireEvent.click(screen.getByRole('button', {
      name: /Attach selected output from Terminal pane 1/i,
    }))
    await waitFor(() => expect(api.registerComposerContext).toHaveBeenCalledWith('session-1', {
      kind: 'terminal',
      path: 'selection',
      selected_text: privateSelection,
      terminal_id: 'terminal-private-id',
    }))
    expect(await screen.findByTestId('composer-context-chip')).toHaveAttribute(
      'data-context-kind',
      'terminal',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Send composer' }))

    await waitFor(() => expect(startStructuredRun).toHaveBeenCalledWith(
      'project-1',
      'session-1',
      {
        catalog_revision: 8,
        segments: [
          {
            kind: 'context_ref', id: 'ctx:terminal:opaque', catalog_revision: 8,
            context_kind: 'terminal',
          },
          { kind: 'text', text: ' ' },
        ],
      },
    ))
    const insertionEvent = vi.mocked(trackEvent).mock.calls.find(([name, properties]) => (
      name === 'kubecode_agent_context_inserted' && properties?.kind === 'terminal'
    ))
    expect(insertionEvent).toEqual([
      'kubecode_agent_context_inserted',
      { agent_id: 'codex', kind: 'terminal' },
    ])
    expect(JSON.stringify(insertionEvent)).not.toContain(privateSelection)
    expect(JSON.stringify(insertionEvent)).not.toContain('terminal-private-id')
  })

  it('publishes only the active writable Session to the global palette and revalidates selections', async () => {
    const catalog = {
      conversation_id: 'session-1', revision: 11, contexts: [],
      items: [
        {
          id: 'cmd:status', kind: 'command' as const, name: 'status', description: 'Show status',
          source_label: 'Codex command', scope: 'session' as const, input_hint: null,
          enabled: true, disabled_reason: null,
        },
        {
          id: 'cmd:review', kind: 'command' as const, name: 'review', description: 'Review changes',
          source_label: 'Codex command', scope: 'session' as const, input_hint: null,
          enabled: true, disabled_reason: null,
        },
        {
          id: 'cap:project:test', kind: 'skill' as const, name: 'test', description: 'Run tests',
          source_label: 'Project skill', scope: 'project' as const, input_hint: null,
          enabled: true, disabled_reason: null,
        },
      ],
    }
    const commandRun = { ...run, id: 'palette-command', message: '/status', status: 'running' as const }
    const dispatchComposerCommand = vi.fn().mockResolvedValue(commandRun)
    let paletteSession: import('./commandPalette').CommandPaletteSessionSnapshot | null = null
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      listConversationRevisions: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue({
        ...emptySessionState,
        available_commands: { availableCommands: [
          { name: 'status', description: 'Show status', input: null },
          { name: 'review', description: 'Review changes', input: { kind: 'text' } },
        ] },
        composer: { catalog },
      }),
      dispatchComposerCommand,
    } as unknown as KubecodeApi

    render(<AgentSessionWorkspace
      agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
      api={api}
      conversation={conversation}
      locale="en"
      onCommandPaletteSessionChange={(next) => { paletteSession = next }}
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    await waitFor(() => expect(paletteSession?.catalog?.revision).toBe(11))
    expect(paletteSession).toMatchObject({
      agentId: 'codex',
      catalogStatus: 'ready',
      conversationId: 'session-1',
      projectId: 'project-1',
      writable: true,
    })
    expect(await paletteSession?.execute({ ...catalog.items[0], catalogRevision: 10 })).toBe(false)
    expect(dispatchComposerCommand).not.toHaveBeenCalled()
    await act(async () => {
      await paletteSession?.execute({ ...catalog.items[1], catalogRevision: 11 })
    })
    expect(screen.getByTestId('composer-draft')).toHaveTextContent('/review')
    expect(dispatchComposerCommand).not.toHaveBeenCalled()

    await act(async () => {
      await paletteSession?.execute({ ...catalog.items[2], catalogRevision: 11 })
    })
    expect(await screen.findByTestId('composer-context-chip')).toHaveTextContent('Project skill')
    const capabilitySelectionEvent = vi.mocked(trackEvent).mock.calls.find(([name, properties]) => (
      name === 'kubecode_command_palette_item_selected' && properties?.kind === 'skill'
    ))
    expect(capabilitySelectionEvent).toEqual([
      'kubecode_command_palette_item_selected',
      { agent_id: 'codex', kind: 'skill' },
    ])
    expect(JSON.stringify(capabilitySelectionEvent)).not.toContain('cap:')
    expect(JSON.stringify(capabilitySelectionEvent)).not.toContain('test')

    await act(async () => {
      await paletteSession?.execute({ ...catalog.items[0], catalogRevision: 11 })
    })
    expect(dispatchComposerCommand).toHaveBeenCalledWith(
      'project-1', 'session-1', 'cmd:status', 11, '',
    )

    await waitFor(() => expect(paletteSession?.writable).toBe(false))
    expect(await paletteSession?.execute({ ...catalog.items[2], catalogRevision: 11 })).toBe(false)
  })

  it('shows OpenCode capability absence only after its catalog is hydrated', async () => {
    const opencodeConversation = { ...conversation, agent_id: 'opencode' as const }
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue({
        ...emptySessionState,
        available_commands: {
          availableCommands: [{ name: 'review', description: 'Review changes' }],
        },
        composer: {
          catalog: {
            conversation_id: conversation.id,
            revision: 1,
            items: [{
              id: 'cmd:review',
              kind: 'command',
              name: 'review',
              description: 'Review changes',
              source_label: 'OpenCode command',
              scope: 'session',
              input_hint: null,
              enabled: true,
              disabled_reason: null,
            }],
            contexts: [],
          },
        },
      }),
    } as unknown as KubecodeApi

    render(<AgentSessionWorkspace
      agents={[{ id: 'opencode', available: true, version: '1.17.20', executable: 'opencode', error: null }]}
      api={api}
      conversation={opencodeConversation}
      locale="en"
      onConversationCreated={vi.fn()}
      onConversationRemoved={vi.fn()}
      onConversationUpdated={vi.fn()}
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add context' }))

    expect(screen.getByRole('status')).toHaveTextContent(
      'No separately invocable OpenCode capabilities are available for this Session.',
    )
    expect(screen.getByRole('button', { name: /review/i })).toBeInTheDocument()
  })

  it('dispatches a selected argument-free ACP command without a visible optimistic user turn', async () => {
    sessionStorage.setItem('kubecode:session-draft:session-1', '/')
    const internalRun = { ...run, id: 'command-run', message: '/status', status: 'running' as const,
      internal: true }
    const dispatchAcpCommand = vi.fn().mockResolvedValue(internalRun)
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      listConversationRevisions: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue({
        ...emptySessionState,
        available_commands: {
          availableCommands: [{ name: 'status', description: 'Show status', input: null }],
        },
      }),
      dispatchAcpCommand,
    } as unknown as KubecodeApi

    render(<AgentSessionWorkspace
      agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
      api={api}
      conversation={conversation}
      locale="en"
      onConversationCreated={vi.fn()}
      onConversationRemoved={vi.fn()}
      onConversationUpdated={vi.fn()}
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    expect(await screen.findByText('/status')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByTestId('agent-input'), { key: 'Enter' })

    await waitFor(() => expect(dispatchAcpCommand).toHaveBeenCalledWith(
      'project-1', 'session-1', 'status', '',
    ))
    expect(screen.getByTestId('composer-draft')).toHaveTextContent('')
    expect(screen.queryByText('/status', { selector: 'article *' })).not.toBeInTheDocument()
  })

  it('keeps a provider /btw command dispatchable while the Session is idle', async () => {
    sessionStorage.setItem('kubecode:session-draft:session-1', '/btw provider input')
    const dispatchAcpCommand = vi.fn().mockResolvedValue({
      ...run,
      id: 'command-run',
      message: '/btw provider input',
      internal: true,
    })
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      listConversationRevisions: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue({
        ...emptySessionState,
        capabilities: { _meta: { claudeCode: { sideQuestion: true } } },
        available_commands: {
          availableCommands: [{
            name: 'btw',
            description: 'Provider command',
            input: { kind: 'text' },
          }],
        },
      }),
      dispatchAcpCommand,
    } as unknown as KubecodeApi

    render(<AgentSessionWorkspace
      agents={[{ id: 'claude_code', available: true, version: '1', executable: 'claude', error: null }]}
      api={api}
      conversation={{ ...conversation, agent_id: 'claude_code' }}
      locale="en"
      onConversationCreated={vi.fn()}
      onConversationRemoved={vi.fn()}
      onConversationUpdated={vi.fn()}
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    fireEvent.keyDown(await screen.findByTestId('agent-input'), { key: 'Enter' })
    await waitFor(() => expect(dispatchAcpCommand).toHaveBeenCalledWith(
      'project-1', 'session-1', 'btw', 'provider input',
    ))
  })

  it('does not submit an advertised command until its required input is present', async () => {
    sessionStorage.setItem('kubecode:session-draft:session-1', '/review')
    const startRun = vi.fn()
    const dispatchAcpCommand = vi.fn()
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      listConversationRevisions: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue({
        ...emptySessionState,
        available_commands: {
          availableCommands: [{
            name: 'review',
            description: 'Review changes',
            input: { kind: 'text', hint: 'focus' },
          }],
        },
      }),
      startRun,
      dispatchAcpCommand,
    } as unknown as KubecodeApi

    render(<AgentSessionWorkspace
      agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
      api={api}
      conversation={conversation}
      locale="en"
      onConversationCreated={vi.fn()}
      onConversationRemoved={vi.fn()}
      onConversationUpdated={vi.fn()}
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    expect(await screen.findByText('focus')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByTestId('agent-input'), { key: 'Enter' })

    expect(dispatchAcpCommand).not.toHaveBeenCalled()
    expect(startRun).not.toHaveBeenCalled()
    expect(screen.getByTestId('composer-draft')).toHaveTextContent('/review')
  })

  it('submits command plus context as ordered opaque structured segments', async () => {
    const catalog = {
      conversation_id: 'session-1',
      revision: 8,
      items: [{
        id: 'cmd:review',
        kind: 'command' as const,
        name: 'review',
        description: 'Review changes',
        source_label: 'Codex',
        scope: 'session' as const,
        input_hint: 'focus',
        enabled: true,
        disabled_reason: null,
      }],
      contexts: [{
        id: 'ctx:main',
        kind: 'file' as const,
        display: 'src/main.ts',
        enabled: true,
        disabled_reason: null,
      }],
    }
    sessionStorage.setItem('kubecode:session-draft:session-1', JSON.stringify({
      version: 2,
      segments: [
        { kind: 'text', text: '/review focus ' },
        { kind: 'context', reference: {
          availability: 'available',
          catalogRevision: 7,
          id: 'ctx:main',
          kind: 'file',
          name: 'main.ts',
          path: 'src/main.ts',
        } },
      ],
    }))
    const startStructuredRun = vi.fn().mockResolvedValue({
      ...run,
      id: 'structured-run',
      internal: true,
      message: '/review focus @src/main.ts',
      status: 'running',
    })
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      listConversationRevisions: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue({
        ...emptySessionState,
        available_commands: {
          availableCommands: [{
            name: 'review',
            description: 'Review changes',
            input: { kind: 'text', hint: 'focus' },
          }],
        },
        composer: { catalog },
      }),
      validateComposerContexts: vi.fn().mockResolvedValue({
        references: [{
          id: 'ctx:main',
          catalog_revision: 7,
          context_kind: 'file',
          available: true,
        }],
        catalog,
      }),
      startStructuredRun,
    } as unknown as KubecodeApi

    render(<AgentSessionWorkspace
      agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
      api={api}
      conversation={conversation}
      locale="en"
      onConversationCreated={vi.fn()}
      onConversationRemoved={vi.fn()}
      onConversationUpdated={vi.fn()}
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    await waitFor(() => expect(screen.getByTestId('composer-context-chip')).toHaveAttribute(
      'data-context-availability',
      'available',
    ))
    fireEvent.keyDown(screen.getByTestId('agent-input'), { key: 'Enter' })

    await waitFor(() => expect(startStructuredRun).toHaveBeenCalledWith(
      'project-1',
      'session-1',
      {
        item_id: 'cmd:review',
        catalog_revision: 8,
        segments: [
          { kind: 'text', text: 'focus ' },
          {
            kind: 'context_ref',
            id: 'ctx:main',
            catalog_revision: 7,
            context_kind: 'file',
          },
        ],
      },
    ))
    expect(JSON.stringify(startStructuredRun.mock.calls[0]?.[2])).not.toContain('src/main.ts')
  })

  it('keeps unknown slash text on the ordinary visible prompt path', async () => {
    sessionStorage.setItem('kubecode:session-draft:session-1', '/unknown')
    const startRun = vi.fn().mockResolvedValue({ ...run, id: 'ordinary-run', message: '/unknown' })
    const dispatchAcpCommand = vi.fn()
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      listConversationRevisions: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue({
        ...emptySessionState,
        available_commands: {
          availableCommands: [{ name: 'status', description: 'Show status', input: null }],
        },
      }),
      startRun,
      dispatchAcpCommand,
    } as unknown as KubecodeApi

    render(<AgentSessionWorkspace
      agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
      api={api}
      conversation={conversation}
      locale="en"
      onConversationCreated={vi.fn()}
      onConversationRemoved={vi.fn()}
      onConversationUpdated={vi.fn()}
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    fireEvent.keyDown(await screen.findByTestId('agent-input'), { key: 'Enter' })

    await waitFor(() => expect(startRun).toHaveBeenCalledWith(
      'project-1', 'session-1', '/unknown',
    ))
    expect(dispatchAcpCommand).not.toHaveBeenCalled()
    expect(await screen.findByText('/unknown')).toBeInTheDocument()
  })

  it('uses arrows and Tab for completion, then Escape dismisses without clearing the draft', async () => {
    sessionStorage.setItem('kubecode:session-draft:session-1', '/')
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      listConversationRevisions: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue({
        ...emptySessionState,
        available_commands: { availableCommands: [
          { name: 'status', description: 'Status', input: null },
          { name: 'review', description: 'Review', input: { kind: 'text', hint: 'focus' } },
        ] },
      }),
    } as unknown as KubecodeApi

    render(<AgentSessionWorkspace
      agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
      api={api}
      conversation={conversation}
      locale="en"
      onConversationCreated={vi.fn()}
      onConversationRemoved={vi.fn()}
      onConversationUpdated={vi.fn()}
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    const input = await screen.findByTestId('agent-input')
    expect(screen.getAllByRole('option')).toHaveLength(2)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(screen.getByTestId('composer-draft')).toHaveTextContent('/review')
    expect(screen.getByText('focus')).toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.getByTestId('composer-draft')).toHaveTextContent('/review')
  })

  it('ignores command shortcuts while the editor is composing', async () => {
    sessionStorage.setItem('kubecode:session-draft:session-1', '/')
    const startRun = vi.fn()
    const dispatchAcpCommand = vi.fn()
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      listConversationRevisions: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue({
        ...emptySessionState,
        available_commands: {
          availableCommands: [{ name: 'status', description: 'Status', input: null }],
        },
      }),
      startRun,
      dispatchAcpCommand,
    } as unknown as KubecodeApi

    render(<AgentSessionWorkspace
      agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
      api={api}
      conversation={conversation}
      locale="en"
      onConversationCreated={vi.fn()}
      onConversationRemoved={vi.fn()}
      onConversationUpdated={vi.fn()}
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    fireEvent.keyDown(await screen.findByTestId('agent-input'), {
      isComposing: true,
      key: 'Enter',
      keyCode: 229,
    })

    expect(startRun).not.toHaveBeenCalled()
    expect(dispatchAcpCommand).not.toHaveBeenCalled()
    expect(screen.getByTestId('composer-draft')).toHaveTextContent('/')
  })

  it('replaces ACP commands from an idle workspace invalidation without reconnecting', async () => {
    sessionStorage.setItem('kubecode:session-draft:session-1', '/')
    const getSessionState = vi.fn()
      .mockResolvedValueOnce({
        ...emptySessionState,
        available_commands: {
          availableCommands: [{ name: 'review', description: 'Review', input: null }],
        },
      })
      .mockResolvedValue({
        ...emptySessionState,
        available_commands: {
          availableCommands: [{ name: 'status', description: 'Status', input: null }],
        },
      })
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      listConversationRevisions: vi.fn().mockResolvedValue([]),
      getSessionState,
    } as unknown as KubecodeApi
    const props = {
      agents: [{ id: 'codex' as const, available: true, version: '1', executable: 'codex', error: null }],
      api,
      conversation,
      locale: 'en' as const,
      onConversationCreated: vi.fn(),
      onConversationRemoved: vi.fn(),
      onConversationUpdated: vi.fn(),
      projectId: 'project-1',
      t: createTranslator('en'),
    }
    const { rerender } = render(<AgentSessionWorkspace {...props} workspaceEvents={[]} />)

    expect(await screen.findByText('/review')).toBeInTheDocument()
    const update = {
      id: 42,
      kind: 'session_state',
      project_id: 'project-1',
      conversation_id: 'session-1',
      run_id: null,
      payload: {},
      created_at: '2026-07-28 12:00:00',
    } as WorkspaceEvent
    rerender(<AgentSessionWorkspace {...props} workspaceEvents={[update]} />)

    expect(await screen.findByText('/status')).toBeInTheDocument()
    expect(screen.queryByText('/review')).not.toBeInTheDocument()
  })

  it('ignores an older command rehydration that finishes after a newer invalidation', async () => {
    sessionStorage.setItem('kubecode:session-draft:session-1', '/')
    const reviewState = {
      ...emptySessionState,
      available_commands: {
        availableCommands: [{ name: 'review', description: 'Review', input: null }],
      },
    }
    const statusState = {
      ...emptySessionState,
      available_commands: {
        availableCommands: [{ name: 'status', description: 'Status', input: null }],
      },
    }
    let resolveOlder!: (state: typeof reviewState) => void
    let resolveNewer!: (state: typeof statusState) => void
    const older = new Promise<typeof reviewState>((resolve) => { resolveOlder = resolve })
    const newer = new Promise<typeof statusState>((resolve) => { resolveNewer = resolve })
    const getSessionState = vi.fn()
      .mockResolvedValueOnce(reviewState)
      .mockReturnValueOnce(older)
      .mockReturnValueOnce(newer)
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      listConversationRevisions: vi.fn().mockResolvedValue([]),
      getSessionState,
    } as unknown as KubecodeApi
    const props = {
      agents: [{ id: 'codex' as const, available: true, version: '1', executable: 'codex', error: null }],
      api,
      conversation,
      locale: 'en' as const,
      onConversationCreated: vi.fn(),
      onConversationRemoved: vi.fn(),
      onConversationUpdated: vi.fn(),
      projectId: 'project-1',
      t: createTranslator('en'),
    }
    const event = (id: number) => ({
      id,
      kind: 'session_state',
      project_id: 'project-1',
      conversation_id: 'session-1',
      run_id: null,
      payload: {},
      created_at: '2026-07-28 12:00:00',
    }) as WorkspaceEvent
    const { rerender } = render(<AgentSessionWorkspace {...props} workspaceEvents={[]} />)
    expect(await screen.findByText('/review')).toBeInTheDocument()

    rerender(<AgentSessionWorkspace {...props} workspaceEvents={[event(42)]} />)
    await waitFor(() => expect(getSessionState).toHaveBeenCalledTimes(2))
    rerender(<AgentSessionWorkspace {...props} workspaceEvents={[event(42), event(43)]} />)
    await waitFor(() => expect(getSessionState).toHaveBeenCalledTimes(3))
    resolveNewer(statusState)
    expect(await screen.findByText('/status')).toBeInTheDocument()
    resolveOlder(reviewState)
    await Promise.resolve()

    expect(screen.queryByText('/review')).not.toBeInTheDocument()
    expect(screen.getByText('/status')).toBeInTheDocument()
  })

  it('rehydrates the provider-authored mode label after the full Session checkpoint', async () => {
    const partialState = {
      ...emptySessionState,
      current_mode: {
        currentModeId: 'build',
        availableModes: [{ id: 'build', name: 'build' }],
      },
    }
    const fullState = {
      ...emptySessionState,
      current_mode: {
        currentModeId: 'build',
        availableModes: [{ id: 'build', name: 'Build' }],
      },
    }
    const getSessionState = vi.fn()
      .mockResolvedValueOnce(partialState)
      .mockResolvedValueOnce(fullState)
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      listConversationRevisions: vi.fn().mockResolvedValue([]),
      getSessionState,
    } as unknown as KubecodeApi
    const props = {
      agents: [{ id: 'codex' as const, available: true, version: '1', executable: 'codex', error: null }],
      api,
      conversation,
      locale: 'en' as const,
      onConversationCreated: vi.fn(),
      onConversationRemoved: vi.fn(),
      onConversationUpdated: vi.fn(),
      projectId: 'project-1',
      t: createTranslator('en'),
    }
    const update = {
      id: 44,
      kind: 'session_state',
      project_id: 'project-1',
      conversation_id: conversation.id,
      run_id: null,
      payload: {},
      created_at: '2026-07-28 12:00:00',
    } as WorkspaceEvent
    const { rerender } = render(<AgentSessionWorkspace {...props} workspaceEvents={[]} />)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Agent settings' })).toHaveTextContent('build'))
    rerender(<AgentSessionWorkspace {...props} workspaceEvents={[update]} />)

    await waitFor(() => expect(getSessionState).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: 'Agent settings' })).toHaveTextContent('Build')
  })

  it('does not let an older Session checkpoint rehydration replace a newer provider label', async () => {
    const state = (name: string) => ({
      ...emptySessionState,
      current_mode: {
        currentModeId: 'build',
        availableModes: [{ id: 'build', name }],
      },
    })
    let resolveOlder!: (value: ReturnType<typeof state>) => void
    let resolveNewer!: (value: ReturnType<typeof state>) => void
    const older = new Promise<ReturnType<typeof state>>((resolve) => { resolveOlder = resolve })
    const newer = new Promise<ReturnType<typeof state>>((resolve) => { resolveNewer = resolve })
    const getSessionState = vi.fn()
      .mockResolvedValueOnce(state('build'))
      .mockReturnValueOnce(older)
      .mockReturnValueOnce(newer)
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      listConversationRevisions: vi.fn().mockResolvedValue([]),
      getSessionState,
    } as unknown as KubecodeApi
    const props = {
      agents: [{ id: 'codex' as const, available: true, version: '1', executable: 'codex', error: null }],
      api,
      conversation,
      locale: 'en' as const,
      onConversationCreated: vi.fn(),
      onConversationRemoved: vi.fn(),
      onConversationUpdated: vi.fn(),
      projectId: 'project-1',
      t: createTranslator('en'),
    }
    const event = (id: number) => ({
      id,
      kind: 'session_state',
      project_id: 'project-1',
      conversation_id: conversation.id,
      run_id: null,
      payload: {},
      created_at: '2026-07-28 12:00:00',
    }) as WorkspaceEvent
    const { rerender } = render(<AgentSessionWorkspace {...props} workspaceEvents={[]} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Agent settings' })).toHaveTextContent('build'))

    rerender(<AgentSessionWorkspace {...props} workspaceEvents={[event(44)]} />)
    await waitFor(() => expect(getSessionState).toHaveBeenCalledTimes(2))
    rerender(<AgentSessionWorkspace {...props} workspaceEvents={[event(44), event(45)]} />)
    await waitFor(() => expect(getSessionState).toHaveBeenCalledTimes(3))
    resolveNewer(state('Build'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Agent settings' })).toHaveTextContent('Build'))

    await act(async () => {
      resolveOlder(state('Stale Build'))
      await older
    })
    expect(screen.getByRole('button', { name: 'Agent settings' })).toHaveTextContent('Build')
    expect(screen.getByRole('button', { name: 'Agent settings' })).not.toHaveTextContent('Stale Build')
  })

  it('does not apply a Session checkpoint response after switching Sessions', async () => {
    const buildState = {
      ...emptySessionState,
      current_mode: {
        currentModeId: 'build',
        availableModes: [{ id: 'build', name: 'Build' }],
      },
    }
    const planState = {
      ...emptySessionState,
      current_mode: {
        currentModeId: 'plan',
        availableModes: [{ id: 'plan', name: 'Plan' }],
      },
    }
    let resolveOldSession!: (value: typeof buildState) => void
    const oldSessionRefresh = new Promise<typeof buildState>((resolve) => {
      resolveOldSession = resolve
    })
    const getSessionState = vi.fn()
      .mockResolvedValueOnce(buildState)
      .mockReturnValueOnce(oldSessionRefresh)
      .mockResolvedValueOnce(planState)
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      listConversationRevisions: vi.fn().mockResolvedValue([]),
      getSessionState,
    } as unknown as KubecodeApi
    const props = {
      agents: [{ id: 'codex' as const, available: true, version: '1', executable: 'codex', error: null }],
      api,
      conversation,
      locale: 'en' as const,
      onConversationCreated: vi.fn(),
      onConversationRemoved: vi.fn(),
      onConversationUpdated: vi.fn(),
      projectId: 'project-1',
      t: createTranslator('en'),
    }
    const update = {
      id: 44,
      kind: 'session_state',
      project_id: 'project-1',
      conversation_id: conversation.id,
      run_id: null,
      payload: {},
      created_at: '2026-07-28 12:00:00',
    } as WorkspaceEvent
    const { rerender } = render(<AgentSessionWorkspace {...props} workspaceEvents={[]} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Agent settings' })).toHaveTextContent('Build'))

    rerender(<AgentSessionWorkspace {...props} workspaceEvents={[update]} />)
    await waitFor(() => expect(getSessionState).toHaveBeenCalledTimes(2))
    const secondConversation = { ...conversation, id: 'session-2', title: 'Second session' }
    rerender(<AgentSessionWorkspace {...props} conversation={secondConversation} workspaceEvents={[update]} />)
    await waitFor(() => expect(getSessionState).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Agent settings' })).toHaveTextContent('Plan'))

    await act(async () => {
      resolveOldSession(buildState)
      await oldSessionRefresh
    })
    expect(screen.getByRole('button', { name: 'Agent settings' })).toHaveTextContent('Plan')
  })

  it('ignores an older option refresh that finishes after a command invalidation', async () => {
    sessionStorage.setItem('kubecode:session-draft:session-1', '/')
    const state = (command: string | null, mode: string) => ({
      ...emptySessionState,
      available_commands: command ? {
        availableCommands: [{ name: command, description: command, input: null }],
      } : { availableCommands: [] },
      current_mode: {
        currentModeId: mode,
        availableModes: [
          { id: 'manual', name: 'Manual' },
          { id: 'acceptEdits', name: 'Accept Edits' },
        ],
      },
    })
    const initialState = state('review', 'manual')
    const staleOptionState = state('review', 'acceptEdits')
    const currentState = state(null, 'acceptEdits')
    let resolveOptionRefresh!: (value: typeof staleOptionState) => void
    let resolveInvalidation!: (value: typeof currentState) => void
    const optionRefresh = new Promise<typeof staleOptionState>((resolve) => {
      resolveOptionRefresh = resolve
    })
    const invalidation = new Promise<typeof currentState>((resolve) => {
      resolveInvalidation = resolve
    })
    const getSessionState = vi.fn()
      .mockResolvedValueOnce(initialState)
      .mockReturnValueOnce(optionRefresh)
      .mockReturnValueOnce(invalidation)
    const setSessionMode = vi.fn().mockResolvedValue(undefined)
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      listConversationRevisions: vi.fn().mockResolvedValue([]),
      getSessionState,
      setSessionMode,
    } as unknown as KubecodeApi
    const props = {
      agents: [{ id: 'codex' as const, available: true, version: '1', executable: 'codex', error: null }],
      api,
      conversation,
      locale: 'en' as const,
      onConversationCreated: vi.fn(),
      onConversationRemoved: vi.fn(),
      onConversationUpdated: vi.fn(),
      projectId: 'project-1',
      t: createTranslator('en'),
    }
    const { rerender } = render(<AgentSessionWorkspace {...props} workspaceEvents={[]} />)
    expect(await screen.findByText('/review')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))
    fireEvent.click(screen.getByRole('button', { name: /Manual.*Agent mode/i }))
    fireEvent.click(screen.getByRole('button', { name: /Accept Edits/ }))
    await waitFor(() => expect(getSessionState).toHaveBeenCalledTimes(2))

    const update = {
      id: 44,
      kind: 'available_commands',
      project_id: 'project-1',
      conversation_id: 'session-1',
      run_id: null,
      payload: {},
      created_at: '2026-07-28 12:00:00',
    } as WorkspaceEvent
    rerender(<AgentSessionWorkspace {...props} workspaceEvents={[update]} />)
    await waitFor(() => expect(getSessionState).toHaveBeenCalledTimes(3))
    resolveInvalidation(currentState)
    await waitFor(() => expect(screen.queryByText('/review')).not.toBeInTheDocument())

    await act(async () => {
      resolveOptionRefresh(staleOptionState)
      await optionRefresh
    })

    expect(screen.queryByText('/review')).not.toBeInTheDocument()
    expect(setSessionMode).toHaveBeenCalledWith(conversation.id, 'acceptEdits')
  })

  it('regenerates a completed turn as a hidden revision in the same Session', async () => {
    const revision = {
      id: 'revision-1',
      conversation_id: conversation.id,
      snapshot_conversation_id: 'revision-snapshot-1',
      forked_at_run_id: run.id,
      created_at: '2026-07-17 12:00:00',
      workspace_restore: 'kept' as const,
      workspace_restore_reason: 'checkpoint_unavailable' as const,
    }
    const reviseConversationAtRun = vi.fn().mockResolvedValue(revision)
    const startRun = vi.fn().mockResolvedValue({ ...run, id: 'run-revised' })
    const onConversationCreated = vi.fn()
    const api = {
      listRuns: vi.fn().mockResolvedValue([run]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue(emptySessionState),
      listConversationRevisions: vi.fn().mockResolvedValue([revision]),
      reviseConversationAtRun,
      startRun,
    } as unknown as KubecodeApi

    render(<AgentSessionWorkspace
      agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
      api={api}
      conversation={conversation}
      locale="en"
      onConversationCreated={onConversationCreated}
      onConversationRemoved={vi.fn()}
      onConversationUpdated={vi.fn()}
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    fireEvent.click(await screen.findByRole('button', { name: 'Regenerate response' }))

    await waitFor(() => expect(reviseConversationAtRun).toHaveBeenCalledWith('session-1', 'run-1'))
    expect(startRun).toHaveBeenCalledWith('project-1', 'session-1', 'Implement it')
    expect(onConversationCreated).not.toHaveBeenCalled()
    expect(await screen.findByText('Version 2 / 2')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The conversation was revised, but workspace files were kept',
    )
  })

  it('keeps the current history when creating a revision fails', async () => {
    const reviseConversationAtRun = vi.fn().mockRejectedValue(new ApiError(
      'revision_failed',
      'Could not create a Session revision',
      409,
    ))
    const startRun = vi.fn()
    const api = {
      listRuns: vi.fn().mockResolvedValue([run]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue(emptySessionState),
      listConversationRevisions: vi.fn().mockResolvedValue([]),
      reviseConversationAtRun,
      startRun,
    } as unknown as KubecodeApi

    render(<AgentSessionWorkspace
      agents={[{ id: 'opencode', available: true, version: '1', executable: 'opencode', error: null }]}
      api={api}
      conversation={{ ...conversation, agent_id: 'opencode' }}
      locale="en"
      onConversationCreated={vi.fn()}
      onConversationRemoved={vi.fn()}
      onConversationUpdated={vi.fn()}
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    fireEvent.click(await screen.findByRole('button', { name: 'Regenerate response' }))

    await waitFor(() => expect(reviseConversationAtRun).toHaveBeenCalledWith(
      'session-1',
      'run-1',
    ))
    expect(startRun).not.toHaveBeenCalled()
    expect(await screen.findByText('Could not create a Session revision')).toBeInTheDocument()
  })

  it('keeps recreated context inside the single message history column', async () => {
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue(emptySessionState),
    } as unknown as KubecodeApi

    const { container } = render(<AgentSessionWorkspace
      agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
      api={api}
      conversation={{ ...conversation, recreated_context: true }}
      locale="en"
      onConversationCreated={vi.fn()}
      onConversationRemoved={vi.fn()}
      onConversationUpdated={vi.fn()}
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    const history = await screen.findByTestId('message-history')
    expect(history).toContainElement(screen.getByText(/Recreated context/))
    expect(container.querySelector('.kubecode-session-timeline')?.children).toHaveLength(1)
  })

  it('shows imported subagent sessions as read-only transcripts', async () => {
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue(emptySessionState),
    } as unknown as KubecodeApi

    render(<AgentSessionWorkspace
      agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
      api={api}
      conversation={{ ...conversation, read_only: true, relationship: 'subagent' }}
      locale="en"
      onConversationCreated={vi.fn()}
      onConversationRemoved={vi.fn()}
      onConversationUpdated={vi.fn()}
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    expect(await screen.findByText('Read-only subagent transcript')).toBeInTheDocument()
    expect(screen.queryByTestId('composer')).not.toBeInTheDocument()
  })

  it('keeps teammate transcripts visible but gates direct turn actions by default', async () => {
    const teammate = {
      ...conversation,
      team_id: 'team-1',
      team_role: 'teammate' as const,
    }
    const api = {
      listRuns: vi.fn().mockResolvedValue([run]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue({
        ...emptySessionState,
        available_commands: {
          availableCommands: [{ name: 'review', description: 'Review changes' }],
        },
      }),
    } as unknown as KubecodeApi
    sessionStorage.setItem('kubecode:session-draft:session-1', '/')

    render(<AgentSessionWorkspace
      agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
      api={api}
      conversation={teammate}
      locale="en"
      onConversationCreated={vi.fn()}
      onConversationRemoved={vi.fn()}
      onConversationUpdated={vi.fn()}
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    expect(await screen.findByTestId('composer')).toHaveAttribute('data-disabled', 'true')
    expect(screen.getByTestId('composer')).toHaveAttribute(
      'data-disabled-placeholder',
      'Direct teammate chat is disabled in Settings',
    )
    expect(screen.queryByRole('button', { name: 'Edit message' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Regenerate response' })).not.toBeInTheDocument()
    expect(screen.queryByText('/review')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add context' })).not.toBeInTheDocument()
  })

  it('restores direct teammate turn actions when the preference is enabled', async () => {
    const teammate = {
      ...conversation,
      team_id: 'team-1',
      team_role: 'teammate' as const,
    }
    const api = {
      listRuns: vi.fn().mockResolvedValue([run]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue(emptySessionState),
    } as unknown as KubecodeApi

    render(<AgentSessionWorkspace
      agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
      allowTeammateChat
      api={api}
      conversation={teammate}
      locale="en"
      onConversationCreated={vi.fn()}
      onConversationRemoved={vi.fn()}
      onConversationUpdated={vi.fn()}
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    expect(await screen.findByTestId('composer')).toHaveAttribute('data-disabled', 'false')
    expect(screen.getByRole('button', { name: 'Edit message' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Regenerate response' })).toBeInTheDocument()
  })

  it('keeps Stop available for a running teammate when direct chat is disabled', async () => {
    const teammate = {
      ...conversation,
      team_id: 'team-1',
      team_role: 'teammate' as const,
    }
    const cancelRun = vi.fn().mockResolvedValue(undefined)
    const api = {
      cancelRun,
      listRuns: vi.fn().mockResolvedValue([{ ...run, status: 'running' as const }]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue(emptySessionState),
    } as unknown as KubecodeApi

    render(<AgentSessionWorkspace
      agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
      api={api}
      conversation={teammate}
      locale="en"
      onConversationCreated={vi.fn()}
      onConversationRemoved={vi.fn()}
      onConversationUpdated={vi.fn()}
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    fireEvent.click(await screen.findByRole('button', { name: 'Stop Agent' }))
    expect(cancelRun).toHaveBeenCalledWith('run-1')
  })

  it('keeps native Agent permission configuration selectable during a run', async () => {
    const running = { ...run, status: 'running' as const }
    const api = {
      listRuns: vi.fn().mockResolvedValue([running]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue({
        ...emptySessionState,
        config_options: {
          configOptions: [{
            type: 'select',
            id: 'permissionMode',
            name: 'Permission',
            currentValue: 'manual',
            options: [
              { value: 'manual', name: 'Manual' },
              { value: 'acceptEdits', name: 'Accept Edits' },
            ],
          }],
        },
      }),
    } as unknown as KubecodeApi

    render(<AgentSessionWorkspace
      agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
      api={api}
      conversation={conversation}
      locale="en"
      onConversationCreated={vi.fn()}
      onConversationRemoved={vi.fn()}
      onConversationUpdated={vi.fn()}
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    const settings = await screen.findByRole('button', { name: 'Agent settings' })
    expect(settings).toBeEnabled()
    fireEvent.click(settings)
    expect(screen.getByRole('button', { name: /Manual.*Permission/i })).toBeEnabled()
  })

  it('shows only distinct Agent-native controls with visible labels', async () => {
    const changedState = {
      ...emptySessionState,
      current_mode: {
        currentModeId: 'acceptEdits',
        availableModes: [
          { id: 'manual', name: 'Manual' },
          { id: 'acceptEdits', name: 'Accept Edits', description: 'Automatically accept file edits' },
        ],
      },
    }
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValueOnce({
        ...emptySessionState,
        current_mode: {
          currentModeId: 'manual',
          availableModes: [
            { id: 'manual', name: 'Manual' },
            { id: 'acceptEdits', name: 'Accept Edits', description: 'Automatically accept file edits' },
          ],
        },
        config_options: {
          configOptions: [
            {
              type: 'select',
              id: 'permissionMode',
              name: 'Permission',
              currentValue: 'manual',
              options: [
                { value: 'manual', name: 'Manual' },
                { value: 'acceptEdits', name: 'Accept Edits' },
              ],
            },
            {
              type: 'select',
              id: 'model',
              name: 'Model',
              currentValue: 'default',
              options: [
                { value: 'default', name: 'Default' },
                { value: 'fast', name: 'Fast' },
              ],
            },
            {
              type: 'select',
              id: 'effort',
              name: 'Effort',
              currentValue: 'default',
              options: [
                { value: 'default', name: 'Default' },
                { value: 'high', name: 'High' },
              ],
            },
          ],
        },
      }).mockResolvedValue(changedState),
      setSessionMode: vi.fn().mockResolvedValue(undefined),
    } as unknown as KubecodeApi

    render(<AgentSessionWorkspace
      agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
      api={api}
      conversation={conversation}
      locale="en"
      onConversationCreated={vi.fn()}
      onConversationRemoved={vi.fn()}
      onConversationUpdated={vi.fn()}
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    const settings = await screen.findByRole('button', { name: 'Agent settings' })
    expect(settings).toHaveTextContent('Manual')
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()

    fireEvent.click(settings)
    expect(screen.queryByText('Permission')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Default.*Model/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Manual.*Agent mode/i }))
    expect(screen.getByText('Automatically accept file edits')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Accept Edits/ }))
    await waitFor(() => {
      expect(api.setSessionMode).toHaveBeenCalledWith(conversation.id, 'acceptEdits')
      expect(screen.getByRole('button', { name: 'Agent settings' })).toHaveTextContent('Accept Edits')
    })
  })

  it('reports a failed Claude mode change and restores the confirmed mode', async () => {
    const claudeConversation = { ...conversation, agent_id: 'claude_code' as const }
    const state = {
      ...emptySessionState,
      current_mode: {
        currentModeId: 'dontAsk',
        availableModes: [
          { id: 'dontAsk', name: "Don't Ask" },
          { id: 'plan', name: 'Plan Mode' },
        ],
      },
    }
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue(state),
      setSessionMode: vi.fn().mockRejectedValue(new Error('ACP session could not reconnect')),
    } as unknown as KubecodeApi

    render(<AgentSessionWorkspace
      agents={[{ id: 'claude_code', available: true, version: '1', executable: 'claude', error: null }]}
      api={api}
      conversation={claudeConversation}
      locale="en"
      onConversationCreated={vi.fn()}
      onConversationRemoved={vi.fn()}
      onConversationUpdated={vi.fn()}
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    const settings = await screen.findByRole('button', { name: 'Agent settings' })
    expect(settings).toHaveTextContent("Don't Ask")
    fireEvent.click(settings)
    fireEvent.click(screen.getByRole('button', { name: /Don't Ask.*Agent mode/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Plan Mode' }))

    expect(await screen.findByText('ACP session could not reconnect')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Agent settings' })).toHaveTextContent("Don't Ask")
  })

  it('does not allow a native mode change during an active turn', async () => {
    const running = { ...run, status: 'running' as const }
    const api = {
      listRuns: vi.fn().mockResolvedValue([running]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue({
        ...emptySessionState,
        current_mode: {
          currentModeId: 'agent',
          availableModes: [
            { id: 'read-only', name: 'Read-only' },
            { id: 'agent', name: 'Agent' },
          ],
        },
        mode_access: { can_change: false, reason: 'active_run' },
      }),
      setSessionMode: vi.fn(),
    } as unknown as KubecodeApi

    render(<AgentSessionWorkspace
      agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
      api={api}
      conversation={conversation}
      locale="en"
      onConversationCreated={vi.fn()}
      onConversationRemoved={vi.fn()}
      onConversationUpdated={vi.fn()}
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    const settings = await screen.findByRole('button', { name: 'Agent settings' })
    expect(settings).toBeEnabled()
    fireEvent.click(settings)
    const mode = screen.getByRole('button', { name: /Agent.*Agent mode/i })
    expect(mode).toBeDisabled()
    fireEvent.click(mode)
    expect(api.setSessionMode).not.toHaveBeenCalled()
  })

  it('renders ACP plans as a progress checklist instead of raw JSON', async () => {
    const onOpenPlan = vi.fn()
    const onPlanChange = vi.fn()
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue({
        ...emptySessionState,
        plan: {
          entries: [
            { content: 'Inspect the workspace', priority: 'medium', status: 'completed' },
            { content: 'Implement the fix', priority: 'high', status: 'in_progress' },
            { content: 'Run verification', priority: 'low', status: 'pending' },
          ],
        },
      }),
    } as unknown as KubecodeApi

    const { container } = render(<AgentSessionWorkspace
      agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
      api={api}
      conversation={conversation}
      locale="en"
      onConversationCreated={vi.fn()}
      onConversationRemoved={vi.fn()}
      onConversationUpdated={vi.fn()}
      onOpenPlan={onOpenPlan}
      onPlanChange={onPlanChange}
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    const summary = await screen.findByRole('button', { name: /Show Agent plan/ })
    expect(summary).toHaveTextContent('1 / 3')
    await waitFor(() => expect(onPlanChange).toHaveBeenLastCalledWith([
      { content: 'Inspect the workspace', priority: 'medium', status: 'completed' },
      { content: 'Implement the fix', priority: 'high', status: 'in_progress' },
      { content: 'Run verification', priority: 'low', status: 'pending' },
    ]))
    fireEvent.click(summary)
    expect(onOpenPlan).toHaveBeenCalled()
    expect(container.querySelectorAll('.kubecode-session-plan-entry')).toHaveLength(0)
    expect(container.querySelector('pre')).not.toBeInTheDocument()
  })

  it('does not render ACP state events as an empty imported message', async () => {
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([
        {
          conversation_id: conversation.id,
          seq: 1,
          kind: 'capabilities',
          payload: { loadSession: true },
          created_at: 'now',
        },
        {
          conversation_id: conversation.id,
          seq: 2,
          kind: 'session_loaded',
          payload: {},
          created_at: 'now',
        },
      ]),
      getSessionState: vi.fn().mockResolvedValue(emptySessionState),
    } as unknown as KubecodeApi

    const { container } = render(<AgentSessionWorkspace
      agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
      api={api}
      conversation={conversation}
      locale="en"
      onConversationCreated={vi.fn()}
      onConversationRemoved={vi.fn()}
      onConversationUpdated={vi.fn()}
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    await waitFor(() => expect(api.listSessionEvents).toHaveBeenCalled())
    expect(container.querySelectorAll('article')).toHaveLength(0)
  })

  it('does not render an unscoped MCP startup event as an empty message', async () => {
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([{
        conversation_id: conversation.id,
        seq: 1,
        kind: 'tool_started',
        payload: {
          tool_id: 'mcp_startup.kubecode-team',
          tool: 'mcp__kubecode-team__startup',
          status: 'failed',
        },
        created_at: 'now',
      }]),
      getSessionState: vi.fn().mockResolvedValue(emptySessionState),
    } as unknown as KubecodeApi

    const { container } = render(<AgentSessionWorkspace
      agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
      api={api}
      conversation={conversation}
      locale="en"
      onConversationCreated={vi.fn()}
      onConversationRemoved={vi.fn()}
      onConversationUpdated={vi.fn()}
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    await waitFor(() => expect(api.listSessionEvents).toHaveBeenCalled())
    expect(container.querySelectorAll('article')).toHaveLength(0)
  })

  it('hydrates an internal Team turn in the teammate Chat without showing its wake prompt', async () => {
    const internalRun = {
      ...run,
      conversation_id: 'session-reviewer',
      id: 'run-reviewer',
      internal: true,
      message: 'Kubecode Team mailbox has new updates',
    }
    const teammate = {
      ...conversation,
      id: 'session-reviewer',
      title: 'Backend Reviewer',
      team_id: 'team-1',
      team_role: 'teammate' as const,
    }
    const api = {
      listRuns: vi.fn().mockResolvedValue([internalRun]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([
        {
          conversation_id: teammate.id,
          seq: 1,
          kind: 'user_message',
          payload: { run_id: internalRun.id, text: internalRun.message, internal: true },
          created_at: 'now',
        },
        {
          conversation_id: teammate.id,
          seq: 2,
          kind: 'thinking_delta',
          payload: { run_id: internalRun.id, text: 'Reviewing backend. ' },
          created_at: 'now',
        },
        {
          conversation_id: teammate.id,
          seq: 3,
          kind: 'text_delta',
          payload: { run_id: internalRun.id, text: 'I found one race.' },
          created_at: 'now',
        },
        {
          conversation_id: teammate.id,
          seq: 4,
          kind: 'run_completed',
          payload: { run_id: internalRun.id, status: 'completed' },
          created_at: 'now',
        },
      ]),
      getSessionState: vi.fn().mockResolvedValue(emptySessionState),
    } as unknown as KubecodeApi

    render(<AgentSessionWorkspace
      agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
      api={api}
      conversation={teammate}
      locale="en"
      onConversationCreated={vi.fn()}
      onConversationRemoved={vi.fn()}
      onConversationUpdated={vi.fn()}
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    expect(await screen.findByText('Reviewing backend. I found one race.')).toBeInTheDocument()
    expect(screen.queryByText('Kubecode Team mailbox has new updates')).not.toBeInTheDocument()
  })

  it('replays a fast slash-command response that arrives before its run is loaded', async () => {
    let resolveRun: ((value: AgentRun) => void) | undefined
    const pendingRun = new Promise<AgentRun>((resolve) => { resolveRun = resolve })
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue(emptySessionState),
      getRun: vi.fn().mockReturnValue(pendingRun),
    } as unknown as KubecodeApi
    const props = {
      agents: [{ id: 'codex' as const, available: true, version: '1', executable: 'codex', error: null }],
      api,
      conversation,
      locale: 'en' as const,
      onConversationCreated: vi.fn(),
      onConversationRemoved: vi.fn(),
      onConversationUpdated: vi.fn(),
      projectId: 'project-1',
      t: createTranslator('en'),
    }
    const { rerender } = render(<AgentSessionWorkspace {...props} workspaceEvents={[]} />)
    await waitFor(() => expect(api.getSessionState).toHaveBeenCalled())

    const started: WorkspaceEvent = {
      id: 10,
      kind: 'run_started',
      project_id: 'project-1',
      conversation_id: conversation.id,
      run_id: 'run-status',
      payload: {},
      created_at: 'now',
    }
    const response: WorkspaceEvent = {
      id: 11,
      kind: 'text_delta',
      project_id: 'project-1',
      conversation_id: conversation.id,
      run_id: 'run-status',
      payload: { text: 'Session is ready' },
      created_at: 'now',
    }
    rerender(<AgentSessionWorkspace {...props} workspaceEvents={[started, response]} />)

    resolveRun?.({ ...run, id: 'run-status', message: '/status' })

    expect(await screen.findByText('/statusSession is ready')).toBeInTheDocument()
  })

  it('hydrates persisted run history and resolves ACP permissions from the global event stream', async () => {
    const api = {
      listRuns: vi.fn().mockResolvedValue([run]),
      listEvents: vi.fn().mockResolvedValue([{
        run_id: run.id,
        seq: 2,
        kind: 'text_delta',
        payload: { text: 'Done' },
        created_at: 'now',
      }]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue(emptySessionState),
      resolvePermission: vi.fn().mockResolvedValue(undefined),
    } as unknown as KubecodeApi
    const props = {
      agents: [{ id: 'codex' as const, available: true, version: '1', executable: 'codex', error: null }],
      api,
      conversation,
      locale: 'en' as const,
      projectId: 'project-1',
      t: createTranslator('en'),
    }
    const { rerender } = render(<AgentSessionWorkspace {...props} workspaceEvents={[]} />)

    expect(await screen.findByText('Implement itDone')).toBeInTheDocument()

    const permissionEvent: WorkspaceEvent = {
      id: 7,
      kind: 'permission_requested',
      project_id: 'project-1',
      conversation_id: 'session-1',
      run_id: 'run-1',
      payload: {
        request_id: 'permission-1',
        tool: 'Shell',
        options: [
          { id: 'always', label: 'Always Allow all Bash', kind: 'allow_always' },
          { id: 'allow', label: 'Allow this Bash command', kind: 'allow_once' },
          { id: 'reject', label: 'Reject this Bash command', kind: 'reject_once' },
        ],
      },
      created_at: 'now',
    }
    rerender(<AgentSessionWorkspace {...props} workspaceEvents={[permissionEvent]} />)
    expect(await screen.findByRole('button', { name: 'Allow all' })).toHaveAttribute('title', 'Always Allow all Bash')
    fireEvent.click(await screen.findByRole('button', { name: 'Allow' }))

    await waitFor(() => {
      expect(api.resolvePermission).toHaveBeenCalledWith('permission-1', 'allow')
    })
  })

  it('keeps separate ACP agent messages as distinct response blocks', async () => {
    const api = {
      listRuns: vi.fn().mockResolvedValue([run]),
      listEvents: vi.fn().mockResolvedValue([
        {
          run_id: run.id,
          seq: 1,
          kind: 'text_delta',
          payload: { message_id: 'message-1', text: 'First answer.' },
          created_at: 'now',
        },
        {
          run_id: run.id,
          seq: 2,
          kind: 'text_delta',
          payload: { message_id: 'message-2', text: 'Second answer.' },
          created_at: 'now',
        },
      ]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue(emptySessionState),
    } as unknown as KubecodeApi

    render(<AgentSessionWorkspace
      agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
      api={api}
      conversation={conversation}
      locale="en"
      onConversationCreated={vi.fn()}
      onConversationRemoved={vi.fn()}
      onConversationUpdated={vi.fn()}
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    const blocks = await screen.findAllByTestId('response-block')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toHaveTextContent('First answer.')
    expect(blocks[1]).toHaveTextContent('Second answer.')
  })

  it('gives native Claude /btw priority over a provider command with the same name', async () => {
    const claudeConversation = { ...conversation, agent_id: 'claude_code' as const }
    const running = { ...run, status: 'running' as const }
    const askSideQuestion = vi.fn().mockResolvedValue({ id: 'side-1', status: 'pending' })
    const dispatchAcpCommand = vi.fn()
    const api = {
      askSideQuestion,
      dispatchAcpCommand,
      cancelRun: vi.fn().mockResolvedValue(undefined),
      listRuns: vi.fn().mockResolvedValue([running]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue({
        ...emptySessionState,
        capabilities: { _meta: { claudeCode: { sideQuestion: true } } },
        available_commands: {
          availableCommands: [{
            name: 'btw',
            description: 'Provider command',
            input: { kind: 'text', hint: 'provider input' },
          }],
        },
      }),
    } as unknown as KubecodeApi
    sessionStorage.setItem('kubecode:session-draft:session-1', '/btw Are tests done?')
    const props = {
      agents: [{ id: 'claude_code' as const, available: true, version: '1', executable: 'claude', error: null }],
      api,
      conversation: claudeConversation,
      locale: 'en' as const,
      onConversationCreated: vi.fn(),
      onConversationRemoved: vi.fn(),
      onConversationUpdated: vi.fn(),
      projectId: 'project-1',
      t: createTranslator('en'),
    }
    const { rerender } = render(<AgentSessionWorkspace {...props} workspaceEvents={[]} />)

    fireEvent.keyDown(await screen.findByTestId('agent-input'), { key: 'Enter' })
    await waitFor(() => expect(askSideQuestion).toHaveBeenCalledWith(
      conversation.id,
      'Are tests done?',
    ))
    expect(dispatchAcpCommand).not.toHaveBeenCalled()
    expect(screen.getByTestId('side-question-panel')).toHaveTextContent('Are tests done?')

    rerender(<AgentSessionWorkspace {...props} workspaceEvents={[{
      id: 10,
      kind: 'side_question_completed',
      project_id: 'project-1',
      conversation_id: conversation.id,
      run_id: run.id,
      payload: {
        id: 'side-1',
        run_id: run.id,
        question: 'Are tests done?',
        answer: 'Yes, the focused tests passed.',
      },
      created_at: 'now',
    }]} />)

    expect(await screen.findByText('Yes, the focused tests passed.')).toBeInTheDocument()
  })

  it('keeps an empty active Claude /btw draft without calling either command channel', async () => {
    const claudeConversation = { ...conversation, agent_id: 'claude_code' as const }
    const askSideQuestion = vi.fn()
    const dispatchAcpCommand = vi.fn()
    const api = {
      askSideQuestion,
      cancelRun: vi.fn().mockResolvedValue(undefined),
      dispatchAcpCommand,
      listRuns: vi.fn().mockResolvedValue([{ ...run, status: 'running' as const }]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue({
        ...emptySessionState,
        capabilities: { _meta: { claudeCode: { sideQuestion: true } } },
        available_commands: {
          availableCommands: [{
            name: 'btw',
            description: 'Provider command',
            input: { kind: 'text' },
          }],
        },
      }),
    } as unknown as KubecodeApi
    sessionStorage.setItem('kubecode:session-draft:session-1', '/btw')

    render(<AgentSessionWorkspace
      agents={[{ id: 'claude_code', available: true, version: '1', executable: 'claude', error: null }]}
      api={api}
      conversation={claudeConversation}
      locale="en"
      onConversationCreated={vi.fn()}
      onConversationRemoved={vi.fn()}
      onConversationUpdated={vi.fn()}
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    fireEvent.keyDown(await screen.findByTestId('agent-input'), { key: 'Enter' })

    expect(askSideQuestion).not.toHaveBeenCalled()
    expect(dispatchAcpCommand).not.toHaveBeenCalled()
    expect(screen.getByTestId('composer-draft')).toHaveTextContent('/btw')
    expect(screen.getByRole('option')).toHaveTextContent('without interrupting')
  })

  it('reconstructs Agent reasoning, tool progress, errors, and completion from persisted events', async () => {
    const running = { ...run, status: 'running' as const }
    const api = {
      listRuns: vi.fn().mockResolvedValue([running]),
      listEvents: vi.fn().mockResolvedValue([
        {
          run_id: run.id,
          seq: 1,
          kind: 'thinking_delta',
          payload: { text: 'Checking files. ' },
          created_at: 'now',
        },
        {
          run_id: run.id,
          seq: 2,
          kind: 'tool_started',
          payload: { tool_id: 'shell-1', tool: 'Shell', input: { command: 'pwd' } },
          created_at: 'now',
        },
        {
          run_id: run.id,
          seq: 3,
          kind: 'tool_updated',
          payload: { tool_id: 'shell-1', tool: 'Shell', output: '/demo' },
          created_at: 'now',
        },
        {
          run_id: run.id,
          seq: 4,
          kind: 'tool_completed',
          payload: { tool_id: 'shell-1', tool: 'Shell', output: '/demo' },
          created_at: 'now',
        },
        {
          run_id: run.id,
          seq: 5,
          kind: 'error',
          payload: { message: 'Recovered warning. ' },
          created_at: 'now',
        },
        {
          run_id: run.id,
          seq: 6,
          kind: 'text_delta',
          payload: { text: 'Finished' },
          created_at: 'now',
        },
        {
          run_id: run.id,
          seq: 7,
          kind: 'run_completed',
          payload: {},
          created_at: 'now',
        },
      ]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue(emptySessionState),
    } as unknown as KubecodeApi

    render(<AgentSessionWorkspace
      agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
      api={api}
      conversation={conversation}
      locale="en"
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    const history = await screen.findByText(/Implement itChecking files/)
    expect(history).toHaveTextContent('Shell:done:/demo')
    expect(history).toHaveTextContent('Recovered warning. Finished')
    expect(history).toHaveAttribute('data-streaming', 'false')
  })

  it('restores a pending ACP permission after the browser reconnects', async () => {
    const waitingRun = { ...run, status: 'waiting_permission' as const }
    const api = {
      listRuns: vi.fn().mockResolvedValue([waitingRun]),
      listEvents: vi.fn().mockResolvedValue([{
        run_id: run.id,
        seq: 3,
        kind: 'permission_requested',
        payload: {
          request_id: 'permission-restored',
          tool: 'Write file',
          options: [{ id: 'allow', label: 'Allow once', kind: 'allow_once' }],
        },
        created_at: 'now',
      }]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue(emptySessionState),
      resolvePermission: vi.fn().mockResolvedValue(undefined),
    } as unknown as KubecodeApi

    const { container } = render(
      <AgentSessionWorkspace
        agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
        api={api}
        conversation={conversation}
        locale="en"
        projectId="project-1"
        t={createTranslator('en')}
        workspaceEvents={[]}
      />,
    )

    expect(await screen.findByText('Write file')).toBeInTheDocument()
    const status = container.querySelector('.kubecode-session-status')
    expect(status).toHaveTextContent('Permission required')
    expect(status?.querySelector('[data-state]')).toHaveAttribute('data-state', 'stuck')
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    await waitFor(() => {
      expect(api.resolvePermission).toHaveBeenCalledWith('permission-restored', 'allow')
    })
  })

  it('routes a teammate permission to the Leader before showing human controls', async () => {
    const waitingRun = { ...run, status: 'waiting_permission' as const }
    const leaderReviewEvent = {
      run_id: run.id,
      seq: 3,
      kind: 'permission_requested',
      payload: {
        request_id: 'permission-team',
        reviewer: 'leader',
        tool: 'Run command',
        options: [{ id: 'allow', label: 'Allow once', kind: 'allow_once' }],
      },
      created_at: 'now',
    }
    const listEvents = vi.fn().mockResolvedValue([leaderReviewEvent])
    const api = {
      listRuns: vi.fn().mockResolvedValue([waitingRun]),
      listEvents,
      listSessionEvents: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue(emptySessionState),
      resolvePermission: vi.fn().mockResolvedValue(undefined),
    } as unknown as KubecodeApi
    const teammate = { ...conversation, team_id: 'team-1', team_role: 'teammate' as const }
    const { rerender } = render(
      <AgentSessionWorkspace
        agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
        api={api}
        conversation={teammate}
        locale="en"
        projectId="project-1"
        t={createTranslator('en')}
        workspaceEvents={[]}
      />,
    )

    expect(await screen.findAllByText('Waiting for Team Leader review')).toHaveLength(2)
    expect(screen.queryByText('Run command')).not.toBeInTheDocument()

    listEvents.mockResolvedValue([{
      ...leaderReviewEvent,
      seq: 4,
      payload: { ...leaderReviewEvent.payload, reviewer: 'user' },
    }])
    rerender(
      <AgentSessionWorkspace
        agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
        api={api}
        conversation={{ ...teammate }}
        locale="en"
        projectId="project-1"
        t={createTranslator('en')}
        workspaceEvents={[]}
      />,
    )

    expect(await screen.findByText('Run command')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument()
  })

  it('keeps a prepared Composer draft isolated per Session during generation', async () => {
    const running = { ...run, status: 'running' as const }
    const secondConversation = { ...conversation, id: 'session-2', title: 'Second session' }
    const api = {
      listRuns: vi.fn().mockImplementation((conversationId: string) => (
        Promise.resolve(conversationId === conversation.id ? [running] : [])
      )),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue(emptySessionState),
    } as unknown as KubecodeApi
    const props = {
      agents: [{ id: 'codex' as const, available: true, version: '1', executable: 'codex', error: null }],
      api,
      locale: 'en' as const,
      projectId: 'project-1',
      t: createTranslator('en'),
      workspaceEvents: [] as WorkspaceEvent[],
    }
    const { rerender } = render(
      <AgentSessionWorkspace {...props} conversation={conversation} />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Type follow-up' }))
    expect(screen.getByTestId('composer-draft')).toHaveTextContent('Prepared follow-up')

    rerender(<AgentSessionWorkspace {...props} conversation={secondConversation} />)
    await waitFor(() => expect(screen.getByTestId('composer-draft')).toBeEmptyDOMElement())

    rerender(<AgentSessionWorkspace {...props} conversation={conversation} />)
    await waitFor(() => {
      expect(screen.getByTestId('composer-draft')).toHaveTextContent('Prepared follow-up')
    })
  })

  it('discards a pending menu context registration when the Session changes', async () => {
    const secondConversation = { ...conversation, id: 'session-2', title: 'Second session' }
    let resolveRegistration: ((value: {
      context: { id: string; kind: 'file'; display: string; enabled: boolean; disabled_reason: null }
      catalog: { conversation_id: string; revision: number; items: never[]; contexts: never[] }
    }) => void) | undefined
    const registerComposerContext = vi.fn(() => new Promise((resolve) => {
      resolveRegistration = resolve
    }))
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      listConversationRevisions: vi.fn().mockResolvedValue([]),
      listSessionEntries: vi.fn().mockResolvedValue([
        { kind: 'file', name: 'README.md', path: 'README.md' },
      ]),
      getSessionState: vi.fn().mockImplementation((conversationId: string) => Promise.resolve({
        ...emptySessionState,
        composer: {
          catalog: {
            conversation_id: conversationId,
            revision: 1,
            items: [],
            contexts: [],
          },
        },
      })),
      registerComposerContext,
      startRun: vi.fn().mockResolvedValue({ ...run, conversation_id: 'session-2' }),
    } as unknown as KubecodeApi
    const props = {
      agents: [{ id: 'codex' as const, available: true, version: '1', executable: 'codex', error: null }],
      api,
      locale: 'en' as const,
      projectId: 'project-1',
      t: createTranslator('en'),
      workspaceEvents: [] as WorkspaceEvent[],
    }
    const { rerender } = render(
      <AgentSessionWorkspace {...props} conversation={conversation} />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Add context' }))
    fireEvent.click(screen.getByRole('button', { name: /Reference file/i }))
    fireEvent.click(await screen.findByRole('option', { name: /README\.md/i }))
    await waitFor(() => expect(registerComposerContext).toHaveBeenCalledWith(
      'session-1',
      { kind: 'file', path: 'README.md' },
    ))

    rerender(<AgentSessionWorkspace {...props} conversation={secondConversation} />)
    const editor = screen.getByTestId('agent-input')
    editor.textContent = 'Continue'
    fireEvent.input(editor)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send composer' })).toBeEnabled())

    resolveRegistration?.({
      context: {
        id: 'ctx:old', kind: 'file', display: 'README.md', enabled: true, disabled_reason: null,
      },
      catalog: { conversation_id: 'session-1', revision: 2, items: [], contexts: [] },
    })
    await waitFor(() => expect(screen.queryByTestId('composer-context-chip')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Send composer' })).toBeEnabled()
  })

  it('restores a Composer draft after the workspace remounts', async () => {
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue(emptySessionState),
    } as unknown as KubecodeApi
    const props = {
      agents: [{ id: 'codex' as const, available: true, version: '1', executable: 'codex', error: null }],
      api,
      conversation,
      locale: 'en' as const,
      projectId: 'project-1',
      t: createTranslator('en'),
      workspaceEvents: [] as WorkspaceEvent[],
    }
    const mounted = render(<AgentSessionWorkspace {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Type follow-up' }))
    expect(screen.getByTestId('composer-draft')).toHaveTextContent('Prepared follow-up')
    mounted.unmount()

    render(<AgentSessionWorkspace {...props} />)
    await waitFor(() => {
      expect(screen.getByTestId('composer-draft')).toHaveTextContent('Prepared follow-up')
    })
  })

  it('locks the workspace send button and Enter for an unvalidated restored context', async () => {
    sessionStorage.setItem('kubecode:session-draft:session-1', JSON.stringify({
      version: 2,
      segments: [{
        kind: 'context',
        reference: {
          availability: 'available',
          catalogRevision: 7,
          id: 'persisted-file',
          kind: 'file',
          name: 'main.ts',
          path: 'src/main.ts',
        },
      }],
    }))
    const startRun = vi.fn()
    const validateComposerContexts = vi.fn().mockRejectedValue(new Error('Session unavailable'))
    const api = {
      listRuns: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      listSessionEvents: vi.fn().mockResolvedValue([]),
      getSessionState: vi.fn().mockResolvedValue(emptySessionState),
      validateComposerContexts,
      startRun,
    } as unknown as KubecodeApi

    render(<AgentSessionWorkspace
      agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
      api={api}
      conversation={conversation}
      locale="en"
      onConversationCreated={vi.fn()}
      onConversationRemoved={vi.fn()}
      onConversationUpdated={vi.fn()}
      projectId="project-1"
      t={createTranslator('en')}
      workspaceEvents={[]}
    />)

    expect(await screen.findByTestId('composer-context-chip')).toHaveAttribute(
      'data-context-availability',
      'stale',
    )
    expect(screen.getByRole('button', { name: 'Send composer' })).toBeDisabled()
    fireEvent.keyDown(screen.getByTestId('agent-input'), { key: 'Enter' })
    expect(startRun).not.toHaveBeenCalled()
    await waitFor(() => expect(validateComposerContexts).toHaveBeenCalledWith('session-1', [{
      id: 'persisted-file', catalog_revision: 7, context_kind: 'file',
    }]))
  })

  it('loads bounded older history without replacing the newest turns', async () => {
    const newer = { ...run, id: 'run-2', message: 'Newer question' }
    const older = { ...run, id: 'run-1', message: 'Older question' }
    const getConversationHistory = vi.fn()
      .mockResolvedValueOnce({
        runs: [newer],
        events: { 'run-2': [] },
        session_events: [],
        next_cursor: 'run-2',
      })
      .mockResolvedValueOnce({
        runs: [older],
        events: { 'run-1': [] },
        session_events: [],
        next_cursor: null,
      })
    const api = {
      getConversationHistory,
      getSessionState: vi.fn().mockResolvedValue(emptySessionState),
      listConversationRevisions: vi.fn().mockResolvedValue([]),
    } as unknown as KubecodeApi
    render(
      <AgentSessionWorkspace
        agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
        api={api}
        conversation={conversation}
        locale="en"
        projectId="project-1"
        t={createTranslator('en')}
        workspaceEvents={[]}
      />,
    )

    expect(await screen.findByText('Newer question')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }))
    expect(await screen.findByText('Older question')).toBeInTheDocument()
    expect(screen.getByText('Newer question')).toBeInTheDocument()
    expect(getConversationHistory).toHaveBeenNthCalledWith(2, 'session-1', 'run-2')
  })
})
