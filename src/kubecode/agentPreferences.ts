export const KUBECODE_AGENT_PREFERENCES_KEY = 'kubecode:agent-preferences:v1'

export type KubecodeAgentPreferences = {
  allowTeammateChat: boolean
}

export const DEFAULT_KUBECODE_AGENT_PREFERENCES: KubecodeAgentPreferences = {
  allowTeammateChat: false,
}

type AgentPreferencesStorage = Pick<Storage, 'getItem' | 'setItem'>

export function normalizeAgentPreferences(value: unknown): KubecodeAgentPreferences {
  const stored = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    allowTeammateChat: typeof stored.allowTeammateChat === 'boolean'
      ? stored.allowTeammateChat
      : DEFAULT_KUBECODE_AGENT_PREFERENCES.allowTeammateChat,
  }
}

export function readAgentPreferences(
  storage: AgentPreferencesStorage,
): KubecodeAgentPreferences {
  try {
    const stored = storage.getItem(KUBECODE_AGENT_PREFERENCES_KEY)
    return normalizeAgentPreferences(stored ? JSON.parse(stored) : null)
  } catch {
    return DEFAULT_KUBECODE_AGENT_PREFERENCES
  }
}

export function writeAgentPreferences(
  storage: AgentPreferencesStorage,
  preferences: KubecodeAgentPreferences,
): void {
  try {
    storage.setItem(KUBECODE_AGENT_PREFERENCES_KEY, JSON.stringify(preferences))
  } catch {
    // Settings remain usable when browser storage is unavailable.
  }
}
