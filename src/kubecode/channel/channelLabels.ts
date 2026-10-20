import type { Translator } from '@/lib/i18n'

import type { ChannelIntent } from '../api'

/** A legacy message type, shown quietly on messages written before ADR 0229. */
export function intentLabel(t: Translator, intent: Exclude<ChannelIntent, 'say'>): string {
  return intent === 'ask' ? t('kubecode.channel.intent.ask') : t('kubecode.channel.intent.request')
}
