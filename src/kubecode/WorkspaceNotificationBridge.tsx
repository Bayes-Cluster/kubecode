import { useEffect, useRef } from 'react'

import { trackEvent } from '@/lib/telemetry'

import type { AgentId, Conversation, Project, WorkspaceEvent } from './api'
import type { KubecodeNotifications, NotificationCategory } from './notificationPreferences'
import {
  notificationCategory,
  notificationPermission,
  shouldNotify,
} from './workspaceNotifications'

export type WorkspaceNotificationCopy = {
  body: (category: NotificationCategory, projectName: string) => string
  untitledSession: string
}

type WorkspaceNotificationBridgeProps = {
  conversations: Conversation[]
  copy?: WorkspaceNotificationCopy
  events: WorkspaceEvent[]
  onOpenSession: (projectId: string, conversationId: string) => void
  preferences: KubecodeNotifications
  projects: Project[]
}

const DEFAULT_COPY: WorkspaceNotificationCopy = {
  body: (category, projectName) => {
    if (category === 'attention') return `${projectName} needs your attention`
    if (category === 'error') return `${projectName} encountered an Agent error`
    return `${projectName} finished an Agent task`
  },
  untitledSession: 'Untitled session',
}

export function WorkspaceNotificationBridge({
  conversations,
  copy = DEFAULT_COPY,
  events,
  onOpenSession,
  preferences,
  projects,
}: WorkspaceNotificationBridgeProps) {
  const processedEventId = useRef(0)
  const attentionNotifications = useRef(new Map<string, Notification>())

  useEffect(() => {
    const nextEvents = events.filter((event) => event.id > processedEventId.current)
    if (nextEvents.length === 0) return
    processedEventId.current = Math.max(...nextEvents.map((event) => event.id))

    for (const event of nextEvents) {
      if (isAttentionResolved(event) && event.conversation_id) {
        attentionNotifications.current.get(event.conversation_id)?.close()
        attentionNotifications.current.delete(event.conversation_id)
        continue
      }
      const category = notificationCategory(event)
      if (!category || !event.project_id || !event.conversation_id) continue
      if (!canSendSystemNotification(preferences, category)) continue

      const conversation = conversations.find((item) => item.id === event.conversation_id)
      const project = projects.find((item) => item.id === event.project_id)
      const notification = new Notification(
        `${agentName(conversation?.agent_id)} · ${conversation?.title || copy.untitledSession}`,
        {
          body: copy.body(category, project?.name ?? event.project_id),
          silent: preferences.sound[category] === 'none',
          tag: `kubecode:${category}:${event.conversation_id}`,
        },
      )
      notification.onclick = () => {
        window.focus()
        onOpenSession(event.project_id as string, event.conversation_id as string)
        trackEvent('kubecode_notification_clicked', { category })
      }
      if (category === 'attention') {
        attentionNotifications.current.get(event.conversation_id)?.close()
        attentionNotifications.current.set(event.conversation_id, notification)
      }
      trackEvent('kubecode_notification_sent', { category })
    }
  }, [conversations, copy, events, onOpenSession, preferences, projects])

  return null
}

function canSendSystemNotification(
  preferences: KubecodeNotifications,
  category: NotificationCategory,
): boolean {
  return notificationPermission() === 'granted'
    && shouldNotify(preferences, category, document.hasFocus())
}

function isAttentionResolved(event: WorkspaceEvent): boolean {
  return event.kind === 'permission_resolved' || event.kind === 'elicitation_resolved'
}

function agentName(id?: AgentId): string {
  if (id === 'claude_code') return 'Claude Code'
  if (id === 'opencode') return 'OpenCode'
  return 'Codex'
}
