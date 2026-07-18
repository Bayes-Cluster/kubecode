export const KUBECODE_EDITOR_PREFERENCES_KEY = 'kubecode:editor-preferences:v1'

export type KubecodeEditorPreferences = {
  autoSave: boolean
}

export const DEFAULT_KUBECODE_EDITOR_PREFERENCES: KubecodeEditorPreferences = {
  autoSave: false,
}

type EditorPreferencesStorage = Pick<Storage, 'getItem' | 'setItem'>

export function normalizeEditorPreferences(value: unknown): KubecodeEditorPreferences {
  const stored = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    autoSave: typeof stored.autoSave === 'boolean'
      ? stored.autoSave
      : DEFAULT_KUBECODE_EDITOR_PREFERENCES.autoSave,
  }
}

export function readEditorPreferences(
  storage: EditorPreferencesStorage,
): KubecodeEditorPreferences {
  try {
    const stored = storage.getItem(KUBECODE_EDITOR_PREFERENCES_KEY)
    return normalizeEditorPreferences(stored ? JSON.parse(stored) : null)
  } catch {
    return DEFAULT_KUBECODE_EDITOR_PREFERENCES
  }
}

export function writeEditorPreferences(
  storage: EditorPreferencesStorage,
  preferences: KubecodeEditorPreferences,
): void {
  try {
    storage.setItem(KUBECODE_EDITOR_PREFERENCES_KEY, JSON.stringify(preferences))
  } catch {
    // Settings remain usable when browser storage is unavailable.
  }
}
