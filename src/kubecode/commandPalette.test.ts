import { describe, expect, it } from 'vitest'

import type { ComposerCatalogSnapshot } from './api'
import { commandPaletteCatalogGroups, isGlobalCommandPaletteShortcut } from './commandPalette'

const catalog: ComposerCatalogSnapshot = {
  conversation_id: 'session-1',
  revision: 7,
  contexts: [],
  items: [
    {
      id: 'cmd:review', kind: 'command', name: 'review', description: 'Review changes',
      source_label: 'Codex command', scope: 'session', input_hint: null,
      enabled: true, disabled_reason: null,
    },
    {
      id: 'cap:project:review', kind: 'skill', name: 'review', description: 'Review repository',
      source_label: 'Project skill', scope: 'project', input_hint: null,
      enabled: true, disabled_reason: null,
    },
    {
      id: 'cap:user:review', kind: 'skill', name: 'review', description: 'Personal review',
      source_label: 'User skill', scope: 'user', input_hint: null,
      enabled: false, disabled_reason: 'ambiguous_source_identity',
    },
    {
      id: 'plugin:format', kind: 'plugin_action', name: 'format', description: 'Format selection',
      source_label: 'Formatter plugin', scope: 'plugin', input_hint: null,
      enabled: true, disabled_reason: null,
    },
    {
      id: 'cap:raw-tool', kind: 'provider_app', name: 'raw-tool', description: 'Not invocable',
      source_label: 'Raw MCP', scope: 'session', input_hint: null,
      enabled: false, disabled_reason: 'unsupported_invocation',
    },
  ],
}

describe('global command palette catalog projection', () => {
  it('groups typed commands, trusted capabilities, and future plugin actions without collisions', () => {
    const groups = commandPaletteCatalogGroups(catalog, 'review')

    expect(groups.commands.map((item) => item.id)).toEqual(['cmd:review'])
    expect(groups.capabilities.map((item) => item.id)).toEqual([
      'cap:project:review',
      'cap:user:review',
    ])
    expect(groups.capabilities[1].enabled).toBe(false)
    expect(groups.pluginActions).toEqual([])
  })

  it('keeps unsupported raw provider rows out and replaces results on catalog revision changes', () => {
    expect(commandPaletteCatalogGroups(catalog, '').capabilities.map((item) => item.id))
      .not.toContain('cap:raw-tool')
    expect(commandPaletteCatalogGroups(catalog, '').pluginActions.map((item) => item.id))
      .toEqual(['plugin:format'])

    const replacement = {
      ...catalog,
      revision: 8,
      items: catalog.items.filter((item) => item.id !== 'cmd:review'),
    }
    expect(commandPaletteCatalogGroups(replacement, '').commands).toEqual([])
  })
})

describe('global command palette shortcut', () => {
  it('uses Command-Shift-P on macOS and Control-Shift-P elsewhere without stealing quick open', () => {
    const event = (overrides: Partial<KeyboardEvent>) => ({
      altKey: false, ctrlKey: false, key: 'p', metaKey: false, shiftKey: false, ...overrides,
    } as KeyboardEvent)

    expect(isGlobalCommandPaletteShortcut(event({ metaKey: true, shiftKey: true }), 'MacIntel')).toBe(true)
    expect(isGlobalCommandPaletteShortcut(event({ ctrlKey: true, shiftKey: true }), 'Linux x86_64')).toBe(true)
    expect(isGlobalCommandPaletteShortcut(event({ metaKey: true }), 'MacIntel')).toBe(false)
    expect(isGlobalCommandPaletteShortcut(event({ ctrlKey: true }), 'Win32')).toBe(false)
    expect(isGlobalCommandPaletteShortcut(event({ metaKey: true, shiftKey: true }), 'Linux x86_64')).toBe(false)
  })
})
