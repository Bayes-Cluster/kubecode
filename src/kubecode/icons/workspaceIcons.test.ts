import { describe, expect, it } from 'vitest'

import en from '@/lib/locales/en.json'

import {
  WORKSPACE_COMMAND_ICONS,
  WORKSPACE_DESTINATION_ICONS,
  WORKSPACE_OBJECT_ICONS,
} from './workspaceIcons'

const families = {
  destinations: WORKSPACE_DESTINATION_ICONS,
  commands: WORKSPACE_COMMAND_ICONS,
  objects: WORKSPACE_OBJECT_ICONS,
}

describe('Workspace icon families (ADR 0227)', () => {
  it('gives each meaning its own glyph within a family', () => {
    for (const [family, entries] of Object.entries(families)) {
      const glyphs = Object.values(entries).map((entry) => entry.Icon)
      expect(new Set(glyphs).size, family).toBe(glyphs.length)
    }
  })

  it('never lends a command glyph to a destination or an object', () => {
    const commands = new Set(Object.values(WORKSPACE_COMMAND_ICONS).map((entry) => entry.Icon))
    for (const entries of [WORKSPACE_DESTINATION_ICONS, WORKSPACE_OBJECT_ICONS]) {
      for (const [meaning, entry] of Object.entries(entries)) {
        expect(commands.has(entry.Icon), meaning).toBe(false)
      }
    }
  })

  it('names every meaning in the locale catalog', () => {
    for (const entries of Object.values(families)) {
      for (const entry of Object.values(entries)) {
        expect((en as Record<string, string>)[entry.labelKey], entry.labelKey).toBeTruthy()
      }
    }
  })

  it('keeps stopping a run and pausing orchestration apart', () => {
    expect(WORKSPACE_COMMAND_ICONS.stopRun.Icon).not.toBe(WORKSPACE_COMMAND_ICONS.pauseOrchestration.Icon)
    expect(WORKSPACE_COMMAND_ICONS.stopRun.labelKey).not.toBe(WORKSPACE_COMMAND_ICONS.pauseOrchestration.labelKey)
  })
})
