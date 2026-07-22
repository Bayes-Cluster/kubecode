import { describe, expect, it } from 'vitest'

import type { AgentSessionState } from './api'
import { nativeSessionOptions } from './agentSessionOptions'

const emptyState: AgentSessionState = {
  capabilities: null,
  available_commands: null,
  current_mode: null,
  config_options: null,
  plan: null,
  usage: null,
}

describe('nativeSessionOptions', () => {
  it('promotes the ACP mode and removes an equivalent config selector', () => {
    const result = nativeSessionOptions({
      ...emptyState,
      current_mode: {
        currentModeId: 'plan',
        availableModes: [
          { id: 'default', name: 'Manual', description: 'Ask before dangerous operations' },
          { id: 'plan', name: 'Plan Mode', description: 'Planning without tool execution' },
        ],
      },
      config_options: {
        configOptions: [
          {
            category: 'mode', id: 'mode', name: 'Mode', type: 'select', currentValue: 'plan',
            options: [
              { value: 'default', name: 'Manual', description: 'Ask before dangerous operations' },
              { value: 'plan', name: 'Plan Mode', description: 'Planning without tool execution' },
            ],
          },
          {
            category: 'model', id: 'model', name: 'Model', type: 'select', currentValue: 'sonnet',
            options: [{ value: 'sonnet', name: 'Sonnet' }],
          },
        ],
      },
    })

    expect(result.mode).toMatchObject({
      kind: 'mode',
      currentValue: 'plan',
      options: [
        { id: 'default', name: 'Manual', description: 'Ask before dangerous operations' },
        { id: 'plan', name: 'Plan Mode', description: 'Planning without tool execution' },
      ],
    })
    expect(result.configs.map((config) => config.id)).toEqual(['model'])
  })

  it('uses an advertised mode config when the Agent has no ACP mode selector', () => {
    const result = nativeSessionOptions({
      ...emptyState,
      config_options: {
        configOptions: [{
          category: 'mode', id: 'mode', name: 'Profile', type: 'select', currentValue: 'build',
          options: [
            { value: 'build', name: 'Build', description: 'Use tools to implement changes' },
            { value: 'plan', name: 'Plan', description: 'Plan before implementation' },
          ],
        }],
      },
    })

    expect(result.mode).toMatchObject({ kind: 'config', id: 'mode', currentValue: 'build' })
    expect(result.configs).toEqual([])
  })

  it('does not return a duplicate fallback mode config to Agent settings', () => {
    const modeConfig = {
      category: 'mode', id: 'profile', name: 'Profile', type: 'select', currentValue: 'build',
      options: [{ value: 'build', name: 'Build' }],
    }
    const result = nativeSessionOptions({
      ...emptyState,
      config_options: { configOptions: [modeConfig, { ...modeConfig }] },
    })

    expect(result.mode).toMatchObject({ kind: 'config', id: 'profile' })
    expect(result.configs).toEqual([])
  })

  it('keeps a distinct provider config even when its name is Mode', () => {
    const result = nativeSessionOptions({
      ...emptyState,
      current_mode: {
        currentModeId: 'build',
        availableModes: [
          { id: 'build', name: 'Build' },
          { id: 'plan', name: 'Plan' },
        ],
      },
      config_options: {
        configOptions: [{
          id: 'permission', name: 'Mode', type: 'select', currentValue: 'ask',
          options: [
            { value: 'ask', name: 'Ask' },
            { value: 'allow', name: 'Allow' },
          ],
        }],
      },
    })

    expect(result.mode?.kind).toBe('mode')
    expect(result.configs.map((config) => config.id)).toEqual(['permission'])
  })

  it('keeps provider-native boolean configuration', () => {
    const result = nativeSessionOptions({
      ...emptyState,
      config_options: {
        configOptions: [{ id: 'fast', name: 'Fast mode', type: 'boolean', currentValue: true }],
      },
    })

    expect(result.configs).toEqual([{
      id: 'fast', kind: 'config', name: 'Fast mode', type: 'boolean', currentValue: true,
    }])
  })
})
