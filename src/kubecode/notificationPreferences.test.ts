import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_KUBECODE_NOTIFICATIONS,
  normalizeKubecodeNotifications,
  readKubecodeNotifications,
  writeKubecodeNotifications,
} from './notificationPreferences'

describe('Kubecode notification preferences', () => {
  it('defaults to always notifying with system sounds for every event category', () => {
    expect(normalizeKubecodeNotifications(null)).toEqual(DEFAULT_KUBECODE_NOTIFICATIONS)
  })

  it('normalizes stored values without accepting unknown modes', () => {
    expect(normalizeKubecodeNotifications({
      systemMode: 'unfocused',
      enabled: { completion: false, attention: true, error: 'yes' },
      sound: { completion: 'none', attention: 'system', error: 'custom' },
      onboardingDismissed: true,
    })).toEqual({
      systemMode: 'unfocused',
      enabled: { completion: false, attention: true, error: true },
      sound: { completion: 'none', attention: 'system', error: 'system' },
      onboardingDismissed: true,
    })
  })

  it('reads and writes one versioned local storage value', () => {
    const storage = {
      getItem: vi.fn(() => JSON.stringify({ systemMode: 'off' })),
      setItem: vi.fn(),
    }

    const preferences = readKubecodeNotifications(storage)
    expect(preferences.systemMode).toBe('off')

    writeKubecodeNotifications(storage, preferences)
    expect(storage.setItem).toHaveBeenCalledWith(
      'kubecode:notifications:v1',
      JSON.stringify(preferences),
    )
  })
})
