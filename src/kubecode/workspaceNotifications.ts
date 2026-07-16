import type { WorkspaceEvent } from './api'
import type { KubecodeNotifications, NotificationCategory } from './notificationPreferences'

const ERROR_RUN_STATUSES = new Set(['failed', 'timed_out', 'interrupted'])

export function notificationCategory(event: WorkspaceEvent): NotificationCategory | null {
  if (event.kind === 'permission_requested' || event.kind === 'elicitation_requested') {
    return 'attention'
  }
  if (event.kind !== 'run_completed') return null
  const status = event.payload.status
  if (status === 'completed' || status === undefined) return 'completion'
  return typeof status === 'string' && ERROR_RUN_STATUSES.has(status) ? 'error' : null
}

export function shouldNotify(
  preferences: KubecodeNotifications,
  category: NotificationCategory,
  windowFocused: boolean,
): boolean {
  if (!preferences.enabled[category] || preferences.systemMode === 'off') return false
  return preferences.systemMode === 'always' || !windowFocused
}
