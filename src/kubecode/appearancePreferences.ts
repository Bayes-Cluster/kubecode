import { applyThemeSelectionToDocument, type ThemeMode } from '@/lib/themeMode'

import { createPreferenceStorage, type PreferenceStorage } from './preferenceStorage'

export const KUBECODE_APPEARANCE_STORAGE_KEY = 'kubecode:appearance:v1'

export const KUBECODE_THEME_OPTIONS = [
  'opencode',
  'system',
  'tokyonight',
  'everforest',
  'ayu',
  'catppuccin',
  'catppuccin-macchiato',
  'gruvbox',
  'kanagawa',
  'nord',
  'matrix',
  'one-dark',
] as const

export type KubecodeTheme = typeof KUBECODE_THEME_OPTIONS[number]

export type KubecodeAppearance = {
  colorScheme: ThemeMode
  theme: KubecodeTheme
  uiFont: string
  uiFontSize: number
  codeFont: string
  terminalFont: string
}

export const DEFAULT_KUBECODE_APPEARANCE: KubecodeAppearance = {
  colorScheme: 'system',
  theme: 'system',
  uiFont: 'System Sans',
  uiFontSize: 14,
  codeFont: 'System Mono',
  terminalFont: 'JetBrainsMono Nerd Font Mono',
}

const COLOR_SCHEMES = new Set<ThemeMode>(['system', 'light', 'dark'])
const THEMES = new Set<KubecodeTheme>(KUBECODE_THEME_OPTIONS)

function normalizedFont(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const font = value.trim().slice(0, 120)
  const invalid = /[;{}]/.test(font) || [...font].some((character) => character.charCodeAt(0) < 32)
  return font && !invalid ? font : fallback
}

function normalizedUiFontSize(value: unknown): number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 12
    && value <= 20
    ? value
    : DEFAULT_KUBECODE_APPEARANCE.uiFontSize
}

export function normalizeKubecodeAppearance(value: unknown): KubecodeAppearance {
  const stored = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const colorScheme = COLOR_SCHEMES.has(stored.colorScheme as ThemeMode)
    ? stored.colorScheme as ThemeMode
    : DEFAULT_KUBECODE_APPEARANCE.colorScheme
  const theme = THEMES.has(stored.theme as KubecodeTheme)
    ? stored.theme as KubecodeTheme
    : DEFAULT_KUBECODE_APPEARANCE.theme

  return {
    colorScheme,
    theme,
    uiFont: normalizedFont(stored.uiFont, DEFAULT_KUBECODE_APPEARANCE.uiFont),
    uiFontSize: normalizedUiFontSize(stored.uiFontSize),
    codeFont: normalizedFont(stored.codeFont, DEFAULT_KUBECODE_APPEARANCE.codeFont),
    terminalFont: normalizedFont(stored.terminalFont, DEFAULT_KUBECODE_APPEARANCE.terminalFont),
  }
}

const appearancePreferenceStorage = createPreferenceStorage({
  defaultValue: () => DEFAULT_KUBECODE_APPEARANCE,
  key: () => KUBECODE_APPEARANCE_STORAGE_KEY,
  normalize: normalizeKubecodeAppearance,
})

export function readKubecodeAppearance(storage: PreferenceStorage): KubecodeAppearance {
  return appearancePreferenceStorage.read(storage)
}

export function writeKubecodeAppearance(
  storage: PreferenceStorage,
  appearance: KubecodeAppearance,
): void {
  appearancePreferenceStorage.write(storage, appearance)
}

export function applyKubecodeAppearance(
  documentObject: Document,
  appearance: KubecodeAppearance,
): void {
  applyThemeSelectionToDocument(documentObject, appearance.colorScheme)
  const root = documentObject.documentElement
  root.setAttribute('data-kubecode-theme', appearance.theme)
  root.style.setProperty('--kubecode-ui-font', fontStack(appearance.uiFont, 'sans'))
  root.style.setProperty('--kubecode-ui-font-size', `${appearance.uiFontSize}px`)
  root.style.setProperty('--kubecode-code-font', fontStack(appearance.codeFont, 'mono'))
  root.style.setProperty('--kubecode-terminal-font', fontStack(appearance.terminalFont, 'mono'))
}

export function terminalFontStack(font: string): string {
  return fontStack(font, 'mono')
}

function fontStack(font: string, kind: 'sans' | 'mono'): string {
  if (font === 'System Sans') {
    return '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  }
  if (font === 'System Mono') {
    return 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
  }
  const escaped = font.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  const fallback = kind === 'sans' ? 'sans-serif' : 'ui-monospace, monospace'
  return `"${escaped}", ${fallback}`
}
