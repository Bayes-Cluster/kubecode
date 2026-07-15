import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { AiAgentMessage } from '@/lib/aiAgentConversation'
import { createTranslator } from '@/lib/i18n'

import { AgentSessionWorkspace } from './AgentSessionWorkspace'
import type { AgentRun, KubecodeApi, WorkspaceEvent } from './api'

vi.mock('@/components/AiPanelChrome', () => ({
  AiPanelMessageHistory: ({ messages }: { messages: AiAgentMessage[] }) => (
    <div>{messages.map((message) => (
      <article key={message.id}>{message.userMessage}{message.response}</article>
    ))}</div>
  ),
  AiPanelComposer: ({ controls }: { controls?: ReactNode }) => (
    <div data-testid="composer">{controls}</div>
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

    expect(await screen.findByRole('combobox', { name: 'Permission' })).toBeEnabled()
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
          { id: 'reject', label: 'Reject', kind: 'reject_once' },
          { id: 'allow', label: 'Allow', kind: 'allow_once' },
        ],
      },
      created_at: 'now',
    }
    rerender(<AgentSessionWorkspace {...props} workspaceEvents={[permissionEvent]} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Allow' }))

    await waitFor(() => {
      expect(api.resolvePermission).toHaveBeenCalledWith('permission-1', 'allow')
    })
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

    expect(await screen.findByText('Write file')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    await waitFor(() => {
      expect(api.resolvePermission).toHaveBeenCalledWith('permission-restored', 'allow')
    })
  })
})
