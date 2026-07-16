import { describe, expect, it } from 'vitest'

import { DEFAULT_KUBECODE_NOTIFICATIONS } from './notificationPreferences'
import { notificationCategory, shouldNotify } from './workspaceNotifications'
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
})
