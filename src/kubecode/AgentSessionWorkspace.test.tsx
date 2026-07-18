import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { AiAgentMessage } from '@/lib/aiAgentConversation'
import { createTranslator } from '@/lib/i18n'

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
  AiPanelComposer: ({ controls, input, leadingControl, onChange }: {
    controls?: ReactNode
    input: string
    leadingControl?: ReactNode
    onChange: (value: string) => void
  }) => (
    <div data-testid="composer">
      {leadingControl}{controls}
      <span data-testid="composer-draft">{input}</span>
      <button onClick={() => onChange('Prepared follow-up')}>Type follow-up</button>
    </div>
  ),
}))

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

  it('regenerates a completed turn as a hidden revision in the same Session', async () => {
    const revision = {
      id: 'revision-1',
      conversation_id: conversation.id,
      snapshot_conversation_id: 'revision-snapshot-1',
      forked_at_run_id: run.id,
      created_at: '2026-07-17 12:00:00',
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
    expect(settings).toHaveTextContent('Manual')
  })

  it('shows only distinct Agent-native controls with visible labels', async () => {
    const changedState = {
      ...emptySessionState,
      current_mode: {
        currentModeId: 'acceptEdits',
        availableModes: [
          { id: 'manual', name: 'Manual' },
          { id: 'acceptEdits', name: 'Accept Edits' },
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
            { id: 'acceptEdits', name: 'Accept Edits' },
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
    expect(settings).toHaveTextContent('Default')
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()

    fireEvent.click(settings)
    expect(screen.queryByText('Permission')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Manual.*Agent mode/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Accept Edits' }))
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

    const mode = await screen.findByRole('button', { name: 'Agent settings' })
    expect(mode).toHaveTextContent("Don't Ask")

    fireEvent.click(mode)
    fireEvent.click(screen.getByRole('button', { name: 'Plan Mode' }))

    expect(await screen.findByText('ACP session could not reconnect')).toBeInTheDocument()
    expect(mode).toHaveTextContent("Don't Ask")
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
})
