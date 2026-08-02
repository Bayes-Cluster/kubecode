import { createPreferenceStorage, type PreferenceStorage } from './preferenceStorage'

export const KUBECODE_AGENT_PREFERENCES_KEY = 'kubecode:agent-preferences:v1'

export type KubecodeAgentPreferences = {
  allowTeammateChat: boolean
}

export const DEFAULT_KUBECODE_AGENT_PREFERENCES: KubecodeAgentPreferences = {
  allowTeammateChat: false,
}

export function normalizeAgentPreferences(value: unknown): KubecodeAgentPreferences {
  const stored = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    allowTeammateChat: typeof stored.allowTeammateChat === 'boolean'
      ? stored.allowTeammateChat
      : DEFAULT_KUBECODE_AGENT_PREFERENCES.allowTeammateChat,
  }
}

const agentPreferenceStorage = createPreferenceStorage({
  defaultValue: () => DEFAULT_KUBECODE_AGENT_PREFERENCES,
  key: () => KUBECODE_AGENT_PREFERENCES_KEY,
  normalize: normalizeAgentPreferences,
})

export function readAgentPreferences(
  storage: PreferenceStorage,
): KubecodeAgentPreferences {
  return agentPreferenceStorage.read(storage)
}

export function writeAgentPreferences(
  storage: PreferenceStorage,
  preferences: KubecodeAgentPreferences,
): void {
  agentPreferenceStorage.write(storage, preferences)
}
