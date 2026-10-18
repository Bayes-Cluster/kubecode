import type { Translator } from '@/lib/i18n'

import type { ChannelIntent, ChannelMessage, Conversation } from '../api'

/** SQLite stores UTC as `YYYY-MM-DD HH:MM:SS`. */
export function messageTime(createdAt: string): string {
  const parsed = new Date(`${createdAt.replace(' ', 'T')}Z`)
  return Number.isNaN(parsed.getTime()) ? createdAt : parsed.toLocaleString()
}

export function authorName(
  t: Translator,
  message: ChannelMessage,
  sessions: Conversation[],
): string {
  if (message.author_kind === 'system') return t('kubecode.channel.author.system')
  if (message.author_kind === 'agent') {
    const session = sessions.find((item) => item.id === message.author_ref)
    return session?.title || t('kubecode.channel.author.agent')
  }
  return t('kubecode.channel.author.researcher')
}

export function intentLabel(t: Translator, intent: ChannelIntent): string {
  switch (intent) {
    case 'ask': return t('kubecode.channel.intent.ask')
    case 'request': return t('kubecode.channel.intent.request')
    default: return t('kubecode.channel.intent.say')
  }
}
