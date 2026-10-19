import { APP_LOCALES, DEFAULT_APP_LOCALE, translate, type AppLocale, type TranslationKey } from '@/lib/i18n'
import type { ResolvedThemeMode } from '@/lib/themeMode'

export type ControlMatrixRequest = { theme: ResolvedThemeMode; locale: AppLocale }

/**
 * `#/controls[?theme=light|dark][&lang=<locale>]` opens the control matrix
 * (ADR 0227) instead of the Workspace. Anything else is not a request for it.
 */
export function controlMatrixRequest(hash: string): ControlMatrixRequest | null {
  const match = /^#\/controls(?:\?(.*))?$/.exec(hash)
  if (!match) return null
  const query = new URLSearchParams(match[1] ?? '')
  const lang = query.get('lang')
  return {
    theme: query.get('theme') === 'dark' ? 'dark' : 'light',
    locale: APP_LOCALES.find((locale) => locale === lang) ?? DEFAULT_APP_LOCALE,
  }
}

/** The longest translation of a label across the shipped locales, to test wrapping, with its locale. */
export function longestTranslation(key: TranslationKey): { text: string; locale: AppLocale } {
  return APP_LOCALES.map((locale) => ({ text: translate(locale, key), locale })).reduce(
    (longest, candidate) => (candidate.text.length > longest.text.length ? candidate : longest),
  )
}
