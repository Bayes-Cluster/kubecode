import type { WorkspaceEvent } from './api'
import type { KubecodeNotifications, NotificationCategory } from './notificationPreferences'

const ERROR_RUN_STATUSES = new Set(['failed', 'timed_out', 'interrupted'])

export type BrowserNotificationPermission = NotificationPermission | 'unsupported'
export type BrowserNotificationDelivery = {
  notification?: Notification
  status: 'sent' | 'permission_required' | 'unsupported' | 'failed'
}

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

export function notificationPermission(): BrowserNotificationPermission {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
}

export async function ensureBrowserNotificationPermission(): Promise<BrowserNotificationPermission> {
  const current = notificationPermission()
  if (current !== 'default') return current
  try {
    return await Notification.requestPermission()
  } catch {
    return 'unsupported'
  }
}

export function deliverBrowserNotification(
  title: string,
  options?: NotificationOptions,
): BrowserNotificationDelivery {
  const permission = notificationPermission()
  if (permission === 'unsupported') return { status: 'unsupported' }
  if (permission !== 'granted') return { status: 'permission_required' }
  try {
    return { notification: new Notification(title, options), status: 'sent' }
  } catch {
    return { status: 'failed' }
  }
}
