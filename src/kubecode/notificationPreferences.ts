import { createPreferenceStorage, type PreferenceStorage } from './preferenceStorage'

export const KUBECODE_NOTIFICATION_STORAGE_KEY = 'kubecode:notifications:v1'

export const NOTIFICATION_CATEGORIES = ['completion', 'attention', 'error'] as const

export type NotificationCategory = typeof NOTIFICATION_CATEGORIES[number]
export type NotificationMode = 'off' | 'unfocused' | 'always'
export type NotificationSound = 'system' | 'none'

export type KubecodeNotifications = {
  systemMode: NotificationMode
  enabled: Record<NotificationCategory, boolean>
  sound: Record<NotificationCategory, NotificationSound>
  onboardingDismissed: boolean
}

export const DEFAULT_KUBECODE_NOTIFICATIONS: KubecodeNotifications = {
  systemMode: 'always',
  enabled: { completion: true, attention: true, error: true },
  sound: { completion: 'system', attention: 'system', error: 'system' },
  onboardingDismissed: false,
}

const MODES = new Set<NotificationMode>(['off', 'unfocused', 'always'])
const SOUNDS = new Set<NotificationSound>(['system', 'none'])

export function normalizeKubecodeNotifications(value: unknown): KubecodeNotifications {
  const stored = record(value)
  const enabled = record(stored.enabled)
  const sound = record(stored.sound)
  return {
    systemMode: MODES.has(stored.systemMode as NotificationMode)
      ? stored.systemMode as NotificationMode
      : DEFAULT_KUBECODE_NOTIFICATIONS.systemMode,
    enabled: mapCategories((category) => (
      typeof enabled[category] === 'boolean'
        ? enabled[category] as boolean
        : DEFAULT_KUBECODE_NOTIFICATIONS.enabled[category]
    )),
    sound: mapCategories((category) => (
      SOUNDS.has(sound[category] as NotificationSound)
        ? sound[category] as NotificationSound
        : DEFAULT_KUBECODE_NOTIFICATIONS.sound[category]
    )),
    onboardingDismissed: typeof stored.onboardingDismissed === 'boolean'
      ? stored.onboardingDismissed
      : DEFAULT_KUBECODE_NOTIFICATIONS.onboardingDismissed,
  }
}

const notificationPreferenceStorage = createPreferenceStorage({
  defaultValue: () => DEFAULT_KUBECODE_NOTIFICATIONS,
  key: () => KUBECODE_NOTIFICATION_STORAGE_KEY,
  normalize: normalizeKubecodeNotifications,
})

export function readKubecodeNotifications(storage: PreferenceStorage): KubecodeNotifications {
  return notificationPreferenceStorage.read(storage)
}

export function writeKubecodeNotifications(
  storage: PreferenceStorage,
  preferences: KubecodeNotifications,
): void {
  notificationPreferenceStorage.write(storage, preferences)
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function mapCategories<Value>(value: (category: NotificationCategory) => Value): Record<NotificationCategory, Value> {
  return Object.fromEntries(NOTIFICATION_CATEGORIES.map((category) => [category, value(category)])) as Record<NotificationCategory, Value>
}
