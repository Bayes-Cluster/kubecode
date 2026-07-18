import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_KUBECODE_AGENT_PREFERENCES,
  normalizeAgentPreferences,
  readAgentPreferences,
  writeAgentPreferences,
} from './agentPreferences'

describe('agent preferences', () => {
  it('keeps direct teammate chat disabled by default', () => {
    expect(normalizeAgentPreferences(null)).toEqual(
      DEFAULT_KUBECODE_AGENT_PREFERENCES,
    )
  })

  it('persists an explicit direct teammate chat choice', () => {
    const storage = {
      getItem: vi.fn().mockReturnValue('{"allowTeammateChat":true}'),
      setItem: vi.fn(),
    }
    expect(readAgentPreferences(storage)).toEqual({ allowTeammateChat: true })
    writeAgentPreferences(storage, { allowTeammateChat: false })
    expect(storage.setItem).toHaveBeenCalledWith(
      'kubecode:agent-preferences:v1',
      '{"allowTeammateChat":false}',
    )
  })
})
