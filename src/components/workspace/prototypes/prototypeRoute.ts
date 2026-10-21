import { APP_LOCALES, DEFAULT_APP_LOCALE, type AppLocale } from '@/lib/i18n'
import type { ResolvedThemeMode } from '@/lib/themeMode'

export const PROTOTYPE_SCREENS = ['general', 'agents', 'review'] as const
export type PrototypeScreen = (typeof PROTOTYPE_SCREENS)[number]

export const PROTOTYPE_STATES = ['default', 'busy', 'error', 'empty'] as const
export type PrototypeState = (typeof PROTOTYPE_STATES)[number]

export type PrototypeRequest = {
  screen: PrototypeScreen
  state: PrototypeState
  theme: ResolvedThemeMode
  locale: AppLocale
  /** Where the Task review was opened from, for its Back. */
  from: Exclude<PrototypeScreen, 'review'>
}

function pick<T extends string>(values: readonly T[], value: string | null, fallback: T): T {
  return values.find((candidate) => candidate === value) ?? fallback
}

/**
 * `#/prototypes[?screen=general|agents|review][&state=default|busy|error|empty]
 * [&theme=light|dark][&lang=<locale>][&from=general|agents]` opens the Workspace
 * prototypes (ADR 0233) with fixture data instead of the Workspace.
 */
export function prototypeRequest(hash: string): PrototypeRequest | null {
  const match = /^#\/prototypes(?:\?(.*))?$/.exec(hash)
  if (!match) return null
  const query = new URLSearchParams(match[1] ?? '')
  return {
    screen: pick(PROTOTYPE_SCREENS, query.get('screen'), 'general'),
    state: pick(PROTOTYPE_STATES, query.get('state'), 'default'),
    theme: query.get('theme') === 'dark' ? 'dark' : 'light',
    locale: pick(APP_LOCALES, query.get('lang'), DEFAULT_APP_LOCALE),
    from: pick(['general', 'agents'] as const, query.get('from'), 'general'),
  }
}

/** The hash for a request; defaults are left out so links stay short. */
export function prototypeHash(request: PrototypeRequest): string {
  const query = new URLSearchParams({ screen: request.screen })
  if (request.state !== 'default') query.set('state', request.state)
  if (request.theme !== 'light') query.set('theme', request.theme)
  if (request.locale !== DEFAULT_APP_LOCALE) query.set('lang', request.locale)
  if (request.screen === 'review' && request.from !== 'general') query.set('from', request.from)
  return `#/prototypes?${query.toString()}`
}
