import { createPreferenceStorage, type PreferenceStorage } from './preferenceStorage'

export const KUBECODE_EDITOR_PREFERENCES_KEY = 'kubecode:editor-preferences:v1'

export type KubecodeEditorPreferences = {
  autoSave: boolean
}

export const DEFAULT_KUBECODE_EDITOR_PREFERENCES: KubecodeEditorPreferences = {
  autoSave: false,
}

export function normalizeEditorPreferences(value: unknown): KubecodeEditorPreferences {
  const stored = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    autoSave: typeof stored.autoSave === 'boolean'
      ? stored.autoSave
      : DEFAULT_KUBECODE_EDITOR_PREFERENCES.autoSave,
  }
}

const editorPreferenceStorage = createPreferenceStorage({
  defaultValue: () => DEFAULT_KUBECODE_EDITOR_PREFERENCES,
  key: () => KUBECODE_EDITOR_PREFERENCES_KEY,
  normalize: normalizeEditorPreferences,
})

export function readEditorPreferences(
  storage: PreferenceStorage,
): KubecodeEditorPreferences {
  return editorPreferenceStorage.read(storage)
}

export function writeEditorPreferences(
  storage: PreferenceStorage,
  preferences: KubecodeEditorPreferences,
): void {
  editorPreferenceStorage.write(storage, preferences)
}
