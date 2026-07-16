import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_KUBECODE_NOTIFICATIONS } from './notificationPreferences'
import { WorkspaceNotificationBridge } from './WorkspaceNotificationBridge'
import type { Conversation, Project, WorkspaceEvent } from './api'

const project: Project = {
  id: 'project-1',
  name: 'Demo',
  path: '/demo',
  workspaces_enabled: false,
}
const conversation: Conversation = {
  id: 'session-1',
  project_id: project.id,
  agent_id: 'codex',
  provider_session_id: null,
  title: 'Fix tests',
  manual_title: null,
  agent_title: 'Fix tests',
}

afterEach(() => vi.unstubAllGlobals())

describe('workspace notification bridge', () => {
  it('sends a system notification for a new attention event and opens its session', () => {
    const created: TestNotification[] = []
    class TestNotification {
      static permission = 'granted' as NotificationPermission
      onclick: (() => void) | null = null
      close = vi.fn()
      constructor(readonly title: string, readonly options?: NotificationOptions) {
        created.push(this)
      }
    }
    vi.stubGlobal('Notification', TestNotification)
    vi.spyOn(window, 'focus').mockImplementation(() => undefined)
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    const onOpenSession = vi.fn()
    const { rerender } = render(
      <WorkspaceNotificationBridge
        conversations={[conversation]}
        events={[]}
        onOpenSession={onOpenSession}
        preferences={DEFAULT_KUBECODE_NOTIFICATIONS}
        projects={[project]}
      />,
    )

    rerender(
      <WorkspaceNotificationBridge
        conversations={[conversation]}
        events={[workspaceEvent('permission_requested')]}
        onOpenSession={onOpenSession}
        preferences={DEFAULT_KUBECODE_NOTIFICATIONS}
        projects={[project]}
      />,
    )

    expect(created).toHaveLength(1)
    expect(created[0]?.title).toBe('Codex · Fix tests')
    expect(created[0]?.options).toMatchObject({
      body: 'Demo needs your attention',
      silent: false,
      tag: 'kubecode:attention:session-1',
    })
    created[0]?.onclick?.()
    expect(onOpenSession).toHaveBeenCalledWith('project-1', 'session-1')
  })

  it('closes an attention notification when the request is resolved', () => {
    const close = vi.fn()
    class TestNotification {
      static permission = 'granted' as NotificationPermission
      onclick: (() => void) | null = null
      close = close
    }
    vi.stubGlobal('Notification', TestNotification)
    const { rerender } = render(
      <WorkspaceNotificationBridge
        conversations={[conversation]}
        events={[]}
        onOpenSession={vi.fn()}
        preferences={DEFAULT_KUBECODE_NOTIFICATIONS}
        projects={[project]}
      />,
    )
    rerender(
      <WorkspaceNotificationBridge
        conversations={[conversation]}
        events={[workspaceEvent('permission_requested'), workspaceEvent('permission_resolved', 2)]}
        onOpenSession={vi.fn()}
        preferences={DEFAULT_KUBECODE_NOTIFICATIONS}
        projects={[project]}
      />,
    )

    expect(close).toHaveBeenCalledOnce()
  })
})

function workspaceEvent(kind: string, id = 1): WorkspaceEvent {
  return {
    id,
    kind,
    project_id: project.id,
    conversation_id: conversation.id,
    run_id: 'run-1',
    payload: {},
    created_at: 'now',
  }
}
