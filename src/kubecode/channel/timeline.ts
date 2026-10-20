/**
 * General as the researcher reads it (ADR 0229 §7): days apart, one author's
 * consecutive messages together, routine Kubecode notes collapsed into
 * activity, and a note that a message was not delivered shown on that
 * message, or on its own when that message is not loaded: a failure is never
 * collapsed. Pure, so the rules are tested without a DOM.
 */

import type { Translator } from '@/lib/i18n'

import type { ChannelMessage, ProjectContextRef } from '../api'

export type TimelineItem =
  | { kind: 'date'; key: string; label: string }
  | { kind: 'message'; message: ChannelMessage; continued: boolean; notes: ChannelMessage[] }
  | { kind: 'activity'; key: string; messages: ChannelMessage[] }

/** Consecutive messages of one author this close together read as one group. */
const GROUP_MS = 5 * 60 * 1000

/** SQLite stores UTC as `YYYY-MM-DD HH:MM:SS`. */
export function messageDate(createdAt: string): Date | null {
  const parsed = new Date(`${createdAt.replace(' ', 'T')}Z`)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** A message's time of day, in the app's language. */
export function shortTime(date: Date, locale: string): string {
  return date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
}

const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`

function dayLabel(date: Date, now: Date, locale: string, t: Translator): string {
  if (dayKey(date) === dayKey(now)) return t('kubecode.channel.today')
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (dayKey(date) === dayKey(yesterday)) return t('kubecode.channel.yesterday')
  return date.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' })
}

/** The message a "not delivered" note is about, or null for any other message. */
export function deliveryNoteSource(note: ChannelMessage): string | null {
  if (note.author_kind !== 'system') return null
  const match = /^(?:route-denied|handoff-denied):(.+)$/.exec(note.client_message_id ?? '')
  return match ? match[1] : null
}

/** A note that something was not delivered: always shown, never collapsed into activity. */
const DELIVERY_FAILURE = /^(?:route-denied|handoff-denied|route-failed):/

/** A Kubecode note with no Task that reports no failure is routine: it collapses into activity. */
const isRoutine = (message: ChannelMessage) => (
  message.author_kind === 'system' && !message.task_id && !DELIVERY_FAILURE.test(message.client_message_id ?? '')
)

const authorKey = (message: ChannelMessage) => (
  `${message.author_kind}:${message.author_member_id ?? message.author_ref ?? ''}`
)
const recipientsKey = (message: ChannelMessage) => JSON.stringify(
  message.mention_member_ids ?? message.mentions.map((mention) => mention.session_id),
)

export function buildTimeline(
  messages: readonly ChannelMessage[],
  { locale, now, t }: { locale: string; now: Date; t: Translator },
): TimelineItem[] {
  const items: TimelineItem[] = []
  const byId = new Map<string, Extract<TimelineItem, { kind: 'message' }>>()
  let day: string | null = null
  for (const message of messages) {
    const date = messageDate(message.created_at)
    if (date && dayKey(date) !== day) {
      day = dayKey(date)
      items.push({ kind: 'date', key: `date:${day}`, label: dayLabel(date, now, locale, t) })
    }
    // A failure about a loaded message is shown on it; one about a message not loaded stands on its own.
    const source = deliveryNoteSource(message)
    const owner = source ? byId.get(source) : undefined
    if (owner) {
      owner.notes.push(message)
      continue
    }
    if (isRoutine(message)) {
      const last = items.at(-1)
      if (last?.kind === 'activity') last.messages.push(message)
      else items.push({ kind: 'activity', key: `activity:${message.id}`, messages: [message] })
      continue
    }
    const previous = items.at(-1)
    const previousDate = previous?.kind === 'message' ? messageDate(previous.message.created_at) : null
    const continued = previous?.kind === 'message'
      && message.reply_to === null
      && authorKey(previous.message) === authorKey(message)
      && recipientsKey(previous.message) === recipientsKey(message)
      && date !== null && previousDate !== null
      && date.getTime() - previousDate.getTime() <= GROUP_MS
    const item = { kind: 'message' as const, message, continued, notes: [] as ChannelMessage[] }
    items.push(item)
    byId.set(message.id, item)
  }
  return items
}

/** A message's references as chips: the Task has its own chip, and each object shows once. */
export function displayReferences(message: ChannelMessage): ProjectContextRef[] {
  const seen = new Set<string>()
  return message.references.filter((ref) => {
    const key = `${ref.kind}:${ref.id}`
    if (seen.has(key) || (ref.kind === 'research' && ref.id === message.task_id)) return false
    seen.add(key)
    return true
  })
}
