import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_KUBECODE_NOTIFICATIONS } from './notificationPreferences'
import {
  deliverBrowserNotification,
  ensureBrowserNotificationPermission,
  notificationCategory,
  shouldNotify,
} from './workspaceNotifications'
import type { WorkspaceEvent } from './api'

function event(kind: string, status?: string): WorkspaceEvent {
  return {
    id: 1,
    kind,
    project_id: 'project-1',
    conversation_id: 'session-1',
    run_id: 'run-1',
    payload: status ? { status } : {},
    created_at: '2026-07-16T00:00:00Z',
  }
}

describe('workspace notifications', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('classifies attention, completion and terminal failures without duplicating raw errors', () => {
    expect(notificationCategory(event('permission_requested'))).toBe('attention')
    expect(notificationCategory(event('elicitation_requested'))).toBe('attention')
    expect(notificationCategory(event('run_completed', 'completed'))).toBe('completion')
    expect(notificationCategory(event('run_completed', 'failed'))).toBe('error')
    expect(notificationCategory(event('run_completed', 'timed_out'))).toBe('error')
    expect(notificationCategory(event('run_completed', 'interrupted'))).toBe('error')
    expect(notificationCategory(event('run_completed', 'cancelled'))).toBeNull()
    expect(notificationCategory(event('error'))).toBeNull()
  })

  it('applies the focus policy and per-category switch', () => {
    expect(shouldNotify(DEFAULT_KUBECODE_NOTIFICATIONS, 'completion', true)).toBe(true)
    expect(shouldNotify({
      ...DEFAULT_KUBECODE_NOTIFICATIONS,
      systemMode: 'unfocused',
    }, 'completion', true)).toBe(false)
    expect(shouldNotify({
      ...DEFAULT_KUBECODE_NOTIFICATIONS,
      systemMode: 'unfocused',
    }, 'completion', false)).toBe(true)
    expect(shouldNotify({
      ...DEFAULT_KUBECODE_NOTIFICATIONS,
      enabled: { ...DEFAULT_KUBECODE_NOTIFICATIONS.enabled, completion: false },
    }, 'completion', false)).toBe(false)
  })

  it('requests permission when needed and reports a delivered notification', async () => {
    class MockNotification {
      static permission: NotificationPermission = 'default'
      static requestPermission = vi.fn(async () => {
        MockNotification.permission = 'granted'
        return 'granted' as NotificationPermission
      })

      constructor(public title: string, public options?: NotificationOptions) {}
    }
    vi.stubGlobal('Notification', MockNotification)

    await expect(ensureBrowserNotificationPermission()).resolves.toBe('granted')
    const delivery = deliverBrowserNotification('Ready', { body: 'Done' })

    expect(MockNotification.requestPermission).toHaveBeenCalledOnce()
    expect(delivery.status).toBe('sent')
    expect(delivery.notification?.title).toBe('Ready')
  })

  it('reports blocked and failed notification delivery instead of failing silently', () => {
    class BlockedNotification {
      static permission: NotificationPermission = 'denied'
    }
    vi.stubGlobal('Notification', BlockedNotification)
    expect(deliverBrowserNotification('Blocked').status).toBe('permission_required')

    class FailingNotification {
      static permission: NotificationPermission = 'granted'
      constructor() { throw new Error('system notifications unavailable') }
    }
    vi.stubGlobal('Notification', FailingNotification)
    expect(deliverBrowserNotification('Failed').status).toBe('failed')
  })
})
