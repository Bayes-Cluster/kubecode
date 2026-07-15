import { applyThemeSelectionToDocument, type ThemeMode } from '@/lib/themeMode'

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
  codeFont: string
  terminalFont: string
}

export const DEFAULT_KUBECODE_APPEARANCE: KubecodeAppearance = {
  colorScheme: 'system',
  theme: 'opencode',
  uiFont: 'System Sans',
  codeFont: 'System Mono',
  terminalFont: 'JetBrainsMono Nerd Font Mono',
}

type AppearanceStorage = Pick<Storage, 'getItem' | 'setItem'>

const COLOR_SCHEMES = new Set<ThemeMode>(['system', 'light', 'dark'])
const THEMES = new Set<KubecodeTheme>(KUBECODE_THEME_OPTIONS)

function normalizedFont(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const font = value.trim().slice(0, 120)
  const invalid = /[;{}]/.test(font) || [...font].some((character) => character.charCodeAt(0) < 32)
  return font && !invalid ? font : fallback
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
    codeFont: normalizedFont(stored.codeFont, DEFAULT_KUBECODE_APPEARANCE.codeFont),
    terminalFont: normalizedFont(stored.terminalFont, DEFAULT_KUBECODE_APPEARANCE.terminalFont),
  }
}

export function readKubecodeAppearance(storage: AppearanceStorage): KubecodeAppearance {
  try {
    const stored = storage.getItem(KUBECODE_APPEARANCE_STORAGE_KEY)
    return normalizeKubecodeAppearance(stored ? JSON.parse(stored) : null)
  } catch {
    return DEFAULT_KUBECODE_APPEARANCE
  }
}

export function writeKubecodeAppearance(
  storage: AppearanceStorage,
  appearance: KubecodeAppearance,
): void {
  try {
    storage.setItem(KUBECODE_APPEARANCE_STORAGE_KEY, JSON.stringify(appearance))
  } catch {
    // Local storage can be unavailable in restricted browser contexts.
  }
}

export function applyKubecodeAppearance(
  documentObject: Document,
  appearance: KubecodeAppearance,
): void {
  applyThemeSelectionToDocument(documentObject, appearance.colorScheme)
  const root = documentObject.documentElement
  root.setAttribute('data-kubecode-theme', appearance.theme)
  root.style.setProperty('--kubecode-ui-font', fontStack(appearance.uiFont, 'sans'))
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
