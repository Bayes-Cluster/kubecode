import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_KUBECODE_APPEARANCE,
  applyKubecodeAppearance,
  normalizeKubecodeAppearance,
  readKubecodeAppearance,
  writeKubecodeAppearance,
} from './appearancePreferences'

describe('Kubecode appearance preferences', () => {
  it('normalizes persisted values and falls back for invalid fields', () => {
    expect(normalizeKubecodeAppearance({
      colorScheme: 'dark',
      theme: 'nord',
      uiFont: 'Inter',
      codeFont: '',
      terminalFont: 42,
    })).toEqual({
      ...DEFAULT_KUBECODE_APPEARANCE,
      colorScheme: 'dark',
      theme: 'nord',
      uiFont: 'Inter',
    })
  })

  it('reads and writes one versioned local storage value', () => {
    const storage = {
      getItem: vi.fn(() => JSON.stringify({ colorScheme: 'light', theme: 'ayu' })),
      setItem: vi.fn(),
    }

    const appearance = readKubecodeAppearance(storage)
    expect(appearance.colorScheme).toBe('light')
    expect(appearance.theme).toBe('ayu')

    writeKubecodeAppearance(storage, appearance)
    expect(storage.setItem).toHaveBeenCalledWith(
      'kubecode:appearance:v1',
      JSON.stringify(appearance),
    )
  })

  it('applies the selected theme and font families to the document root', () => {
    applyKubecodeAppearance(document, {
      colorScheme: 'dark',
      theme: 'tokyonight',
      uiFont: 'Inter',
      codeFont: 'Berkeley Mono',
      terminalFont: 'JetBrainsMono Nerd Font Mono',
    })

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(document.documentElement).toHaveAttribute('data-kubecode-theme', 'tokyonight')
    expect(document.documentElement.style.getPropertyValue('--kubecode-ui-font')).toContain('Inter')
    expect(document.documentElement.style.getPropertyValue('--kubecode-code-font')).toContain('Berkeley Mono')
    expect(document.documentElement.style.getPropertyValue('--kubecode-terminal-font')).toContain('JetBrainsMono Nerd Font Mono')
  })
})
