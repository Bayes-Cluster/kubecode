import { describe, expect, it } from 'vitest'

import { APP_LOCALES, createTranslator, type TranslationKey } from '@/lib/i18n'
import en from '@/lib/locales/en.json'

/** Task, research and work copy that names the General conversation as a place (not the General Agent). */
const PLACE_KEYS = (Object.entries(en) as Array<[TranslationKey, string]>)
  .filter(([key, text]) => /^kubecode\.(task|research|work)\./.test(key) && /\bGeneral\b(?! Agent)/.test(text))
  .map(([key]) => key)

/** Copy that names the General Agent. */
const AGENT_KEYS = (Object.entries(en) as Array<[TranslationKey, string]>)
  .filter(([, text]) => text.includes('General Agent'))
  .map(([key]) => key)

describe('Task copy names General in each language (ADR 0230, as ADR 0229 for the conversation)', () => {
  it('writes the General conversation exactly as the catalog names it', () => {
    expect(PLACE_KEYS.length).toBeGreaterThan(15)
    for (const locale of APP_LOCALES) {
      const t = createTranslator(locale)
      const general = t('kubecode.channel.general')
      expect(t('kubecode.vocab.destination.general'), locale).toBe(general)
      for (const key of PLACE_KEYS) {
        expect(t(key), `${locale} ${key}`).toContain(general)
      }
    }
  })

  it('uses one form of the General Agent\'s name in each language', () => {
    expect(AGENT_KEYS.length).toBeGreaterThan(10)
    for (const locale of APP_LOCALES) {
      const t = createTranslator(locale)
      // Catalogs that keep the English name keep it everywhere; the others never mix it in.
      const english = t('kubecode.task.activity.someone').includes('General Agent')
      for (const key of AGENT_KEYS) {
        expect(t(key).includes('General Agent'), `${locale} ${key}: ${t(key)}`).toBe(english)
      }
    }
  })
})
