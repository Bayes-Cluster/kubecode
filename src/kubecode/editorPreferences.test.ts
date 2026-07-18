import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_KUBECODE_EDITOR_PREFERENCES,
  normalizeEditorPreferences,
  readEditorPreferences,
  writeEditorPreferences,
} from './editorPreferences'

describe('editor preferences', () => {
  it('keeps manual save as the default', () => {
    expect(normalizeEditorPreferences(null)).toEqual(
      DEFAULT_KUBECODE_EDITOR_PREFERENCES,
    )
  })

  it('persists an explicit Auto Save choice', () => {
    const storage = {
      getItem: vi.fn().mockReturnValue('{"autoSave":true}'),
      setItem: vi.fn(),
    }
    expect(readEditorPreferences(storage)).toEqual({ autoSave: true })
    writeEditorPreferences(storage, { autoSave: false })
    expect(storage.setItem).toHaveBeenCalledWith(
      'kubecode:editor-preferences:v1',
      '{"autoSave":false}',
    )
  })
})
