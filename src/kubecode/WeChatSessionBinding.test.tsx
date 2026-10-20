import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'
import { trackEvent } from '@/lib/telemetry'

import { SessionSidebarList } from './SessionSidebarList'
import { ApiError } from './api'
import type { Conversation, IlinkStatus, KubecodeApi, Project, WorkspaceEvent } from './api'
import { WeChatSettingsPanel } from './app/WeChatSettingsPanel'
import { useWeChatBinding, type WeChatBinding } from './app/useWeChatBinding'

vi.mock('@/lib/telemetry', () => ({ trackEvent: vi.fn() }))

const t = createTranslator('en')
const project: Project = { id: 'project-1', name: 'Demo', path: '/srv/private/demo', workspaces_enabled: false }

function session(id: string, title: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id,
    agent_session_id: `agent-${id}`,
    project_id: 'project-1',
    agent_id: 'codex',
    provider_session_id: null,
    title,
    manual_title: null,
    agent_title: title,
    execution_mode: 'shared',
    workspace_path: null,
    recreated_context: false,
    ...overrides,
  }
}

function status(bound: string | null, linked = true): IlinkStatus {
  return {
    status: 'connected',
    account_id: linked ? 'ilink_bot_private_id' : null,
    display_name: 'Ops Bot',
    bound_conversation_id: bound,
    login_active: false,
    login_expires_in_ms: null,
    login_generation: null,
  }
}

function statusEvent(id: number, payload: Record<string, unknown> = {}): WorkspaceEvent {
  return {
    id,
    kind: 'ilink_status_changed',
    project_id: null,
    conversation_id: null,
    run_id: null,
    payload: { status: 'connected', ...payload },
    created_at: '',
  }
}

beforeEach(() => vi.mocked(trackEvent).mockClear())

describe('useWeChatBinding', () => {
  it('loads, binds, and converges on status events from other tabs', async () => {
    const api = {
      ilinkStatus: vi.fn()
        .mockResolvedValueOnce(status('session-1'))
        .mockResolvedValue(status('session-3')),
      ilinkBindSession: vi.fn().mockResolvedValue({ bound_conversation_id: 'session-2' }),
      ilinkUnbindSession: vi.fn().mockResolvedValue({ bound_conversation_id: null }),
    } as unknown as KubecodeApi
    const { result, rerender } = renderHook(
      ({ events }) => useWeChatBinding(api, events),
      { initialProps: { events: [] as WorkspaceEvent[] } },
    )
    await waitFor(() => expect(result.current.boundConversationId).toBe('session-1'))
    expect(result.current.linked).toBe(true)

    await act(() => result.current.bind('session-2'))
    expect(result.current.boundConversationId).toBe('session-2')

    // Another tab switched the binding: the event triggers a refetch.
    rerender({ events: [statusEvent(10)] })
    await waitFor(() => expect(result.current.boundConversationId).toBe('session-3'))

    await act(() => result.current.unbind())
    expect(result.current.boundConversationId).toBeNull()
  })

  it('fences stale responses so an older bind never wins', async () => {
    let finishFirst: (value: { bound_conversation_id: string }) => void = () => undefined
    const api = {
      ilinkStatus: vi.fn().mockResolvedValue(status(null)),
      ilinkBindSession: vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve }))
        .mockResolvedValueOnce({ bound_conversation_id: 'session-2' }),
    } as unknown as KubecodeApi
    const { result } = renderHook(() => useWeChatBinding(api, []))
    await waitFor(() => expect(api.ilinkStatus).toHaveBeenCalled())
    let first: Promise<void> = Promise.resolve()
    act(() => { first = result.current.bind('session-1') })
    await act(() => result.current.bind('session-2'))
    await act(async () => {
      finishFirst({ bound_conversation_id: 'session-1' })
      await first
    })
    expect(result.current.boundConversationId).toBe('session-2')
  })

  it('maps server refusals to categorical reasons and re-reads the binding', async () => {
    const api = {
      ilinkStatus: vi.fn().mockResolvedValue(status('session-1')),
      ilinkBindSession: vi.fn().mockRejectedValue(
        new ApiError('ilink_binding_rejected', 'cannot bind', 409, null, 'archived'),
      ),
    } as unknown as KubecodeApi
    const { result } = renderHook(() => useWeChatBinding(api, []))
    await waitFor(() => expect(result.current.boundConversationId).toBe('session-1'))
    await act(() => result.current.bind('session-9'))
    expect(result.current.rejected).toBe('archived')
    expect(result.current.boundConversationId).toBe('session-1')
    await waitFor(() => expect(api.ilinkStatus).toHaveBeenCalledTimes(2))
  })

  it('remembers why the server cleared the binding', async () => {
    const api = {
      ilinkStatus: vi.fn()
        .mockResolvedValueOnce(status('session-1'))
        .mockResolvedValue(status(null)),
    } as unknown as KubecodeApi
    const { result, rerender } = renderHook(
      ({ events }) => useWeChatBinding(api, events),
      { initialProps: { events: [] as WorkspaceEvent[] } },
    )
    await waitFor(() => expect(result.current.boundConversationId).toBe('session-1'))
    rerender({ events: [statusEvent(4, { binding_reason: 'session_removed', conversation_id: null })] })
    await waitFor(() => expect(result.current.boundConversationId).toBeNull())
    expect(result.current.clearedReason).toBe('session_removed')
  })

  it('settles pending even when the status event outruns the bind response', async () => {
    let finishBind: (value: { bound_conversation_id: string }) => void = () => undefined
    const api = {
      ilinkStatus: vi.fn()
        .mockResolvedValueOnce(status(null))
        .mockResolvedValue(status('session-2')),
      ilinkBindSession: vi.fn(() => new Promise((resolve) => { finishBind = resolve })),
    } as unknown as KubecodeApi
    const { result, rerender } = renderHook(
      ({ events }) => useWeChatBinding(api, events),
      { initialProps: { events: [] as WorkspaceEvent[] } },
    )
    await waitFor(() => expect(api.ilinkStatus).toHaveBeenCalledTimes(1))
    let binding: Promise<void> = Promise.resolve()
    act(() => { binding = result.current.bind('session-2') })
    expect(result.current.pending).toBe(true)
    // The server's status event arrives before the HTTP response.
    rerender({ events: [statusEvent(7, { conversation_id: 'session-2' })] })
    await waitFor(() => expect(result.current.boundConversationId).toBe('session-2'))
    await act(async () => {
      finishBind({ bound_conversation_id: 'session-2' })
      await binding
    })
    expect(result.current.pending).toBe(false)
  })

  it('drops a stale cleared-binding note once a binding exists again', async () => {
    const api = {
      ilinkStatus: vi.fn().mockResolvedValue(status(null)),
    } as unknown as KubecodeApi
    const { result, rerender } = renderHook(
      ({ events }) => useWeChatBinding(api, events),
      { initialProps: { events: [] as WorkspaceEvent[] } },
    )
    rerender({ events: [statusEvent(3, { binding_reason: 'session_archived', conversation_id: null })] })
    await waitFor(() => expect(result.current.clearedReason).toBe('session_archived'))
    rerender({ events: [
      statusEvent(3, { binding_reason: 'session_archived', conversation_id: null }),
      statusEvent(4, { conversation_id: 'session-5' }),
    ] })
    await waitFor(() => expect(result.current.clearedReason).toBeNull())
  })

  it('stays inert when the API has no WeChat surface', () => {
    const { result } = renderHook(() => useWeChatBinding({} as KubecodeApi, []))
    expect(result.current.linked).toBe(false)
    expect(result.current.boundConversationId).toBeNull()
  })
})

function binding(overrides: Partial<WeChatBinding> = {}): WeChatBinding {
  return {
    linked: true,
    boundConversationId: 'session-1',
    clearedReason: null,
    pending: false,
    rejected: null,
    bind: vi.fn().mockResolvedValue(undefined),
    unbind: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function renderSidebar(conversations: Conversation[], wechat: WeChatBinding) {
  return render(
    <SessionSidebarList
      activeConversationId={null}
      api={{} as KubecodeApi}
      conversations={conversations}
      onConversationCreated={vi.fn()}
      onConversationRemoved={vi.fn()}
      onConversationUpdated={vi.fn()}
      onError={vi.fn()}
      onNewSession={vi.fn()}
      onSelect={vi.fn()}
      projects={[project]}
      scopeProjectId="project-1"
      t={t}
      wechat={wechat}
    />,
  )
}

function openActions(title: string) {
  fireEvent.pointerDown(screen.getByRole('button', { name: `Actions for ${title}` }), {
    button: 0,
    ctrlKey: false,
    pointerType: 'mouse',
  })
}

describe('Session sidebar WeChat controls', () => {
  it('marks exactly the bound Session and offers stop/use commands', async () => {
    const wechat = binding()
    renderSidebar([session('session-1', 'Bound work'), session('session-2', 'Other work')], wechat)
    expect(screen.getByRole('button', { name: 'Bound work, active WeChat Session' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Other work' })).toBeInTheDocument()
    expect(document.querySelectorAll('.kubecode-session-wechat-marker')).toHaveLength(1)

    openActions('Bound work')
    fireEvent.click(await screen.findByText('Stop using for WeChat'))
    expect(wechat.unbind).toHaveBeenCalledTimes(1)

    openActions('Other work')
    fireEvent.click(await screen.findByText('Use for WeChat'))
    expect(wechat.bind).toHaveBeenCalledWith('session-2')
    expect(trackEvent).toHaveBeenCalledWith(
      'kubecode_wechat_session_binding_changed',
      { action: 'bind', source: 'sidebar' },
    )
  })

  it('disables unbindable Sessions with a localized reason', async () => {
    const wechat = binding({ boundConversationId: null })
    renderSidebar([
      session('session-1', 'Archived work', { archived: true }),
      session('session-2', 'Read only work', { read_only: true }),
    ], wechat)
    openActions('Read only work')
    const item = await screen.findByRole('menuitem', { name: /Use for WeChat \(read-only\)/ })
    expect(item).toHaveAttribute('data-disabled')
    fireEvent.click(item)
    expect(wechat.bind).not.toHaveBeenCalled()
  })

  it('shows no WeChat controls when no account is linked', async () => {
    renderSidebar([session('session-1', 'Bound work')], binding({ linked: false }))
    expect(screen.getByRole('button', { name: 'Bound work' })).toBeInTheDocument()
    openActions('Bound work')
    await screen.findByText('Archive session')
    expect(screen.queryByText(/WeChat/)).not.toBeInTheDocument()
  })
})

describe('WeChat Settings active Session selector', () => {
  function renderPanel(wechat: WeChatBinding, conversations: Conversation[]) {
    const api = {
      ilinkStatus: vi.fn().mockResolvedValue(status(wechat.boundConversationId)),
      ilinkPollLogin: vi.fn(),
      ilinkQuickPrompts: vi.fn().mockResolvedValue({ slots: 9, max_chars: 2000, prompts: [] }),
    } as unknown as KubecodeApi
    return render(
      <WeChatSettingsPanel
        api={api}
        binding={wechat}
        conversations={conversations}
        projects={[project]}
        t={t}
        workspaceEvents={[]}
      />,
    )
  }

  it('groups Sessions by Project, disables unbindable ones, and binds or unbinds', async () => {
    const wechat = binding()
    renderPanel(wechat, [
      session('session-1', 'Bound work'),
      session('session-2', 'Other work'),
      session('session-3', 'Team work', { team_id: 'team-1' }),
      session('session-4', 'Helper', { relationship: 'subagent' }),
    ])
    const selector = await screen.findByRole('combobox', { name: 'Active Session' })
    expect(selector).toHaveTextContent('Bound work')
    fireEvent.click(selector)
    expect(await screen.findByText('Demo')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Team work (Team Session)' })).toHaveAttribute('data-disabled')
    expect(screen.queryByRole('option', { name: /Helper/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: 'Other work' }))
    expect(wechat.bind).toHaveBeenCalledWith('session-2')

    fireEvent.click(screen.getByRole('button', { name: 'Stop using' }))
    expect(wechat.unbind).toHaveBeenCalledTimes(1)
    // Project paths never appear.
    expect(document.body.innerHTML).not.toContain('/srv/private/demo')
  })

  it('explains a server-cleared binding and a refused selection', async () => {
    renderPanel(binding({
      boundConversationId: null,
      clearedReason: 'session_archived',
      rejected: 'team',
    }), [session('session-2', 'Other work')])
    expect(await screen.findByText('The active Session was archived. Choose another Session.'))
      .toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent("Team Sessions can't be used with WeChat.")
    expect(screen.getByRole('combobox', { name: 'Active Session' })).toHaveTextContent('No active Session')
    expect(screen.queryByRole('button', { name: 'Stop using' })).not.toBeInTheDocument()
  })
})
