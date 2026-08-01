import { describe, expect, it, vi } from 'vitest'

import { createPreferenceStorage } from './preferenceStorage'

type Preference = { enabled: boolean }

const preferences = createPreferenceStorage<Preference, [scope: string]>({
  defaultValue: () => ({ enabled: false }),
  key: (scope) => `preferences:${scope}`,
  migrate: (read, scope) => {
    const legacy = read(`legacy:${scope}`)
    return legacy && typeof legacy === 'object'
      ? { enabled: (legacy as Record<string, unknown>).active === true }
      : undefined
  },
  normalize: (value) => {
    if (!value || typeof value !== 'object') return undefined
    const enabled = (value as Record<string, unknown>).enabled
    return typeof enabled === 'boolean' ? { enabled } : undefined
  },
})

describe('preference storage', () => {
  it('reads and writes typed values under dynamic keys', () => {
    const storage = {
      getItem: vi.fn(() => '{"enabled":true}'),
      setItem: vi.fn(),
    }

    expect(preferences.read(storage, 'project-1')).toEqual({ enabled: true })
    preferences.write(storage, { enabled: false }, 'project-1')

    expect(storage.getItem).toHaveBeenCalledWith('preferences:project-1')
    expect(storage.setItem).toHaveBeenCalledWith('preferences:project-1', '{"enabled":false}')
  })

  it('uses migrated values only when the current value is missing or invalid', () => {
    const values = new Map([
      ['legacy:project-1', '{"active":true}'],
      ['preferences:project-2', '{broken'],
      ['legacy:project-2', '{"active":true}'],
    ])
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: vi.fn(),
    }

    expect(preferences.read(storage, 'project-1')).toEqual({ enabled: true })
    expect(preferences.read(storage, 'project-2')).toEqual({ enabled: true })
  })

  it('falls back without throwing when storage is unavailable', () => {
    const storage = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
    }

    expect(preferences.read(storage, 'project-1')).toEqual({ enabled: false })
    expect(() => preferences.write(storage, { enabled: true }, 'project-1')).not.toThrow()
  })
})
