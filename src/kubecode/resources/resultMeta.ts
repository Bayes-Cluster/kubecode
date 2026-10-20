/**
 * How a search result is described in words (ADR 0231 §2): kind, version,
 * state, the Task it belongs to, and how long ago it changed. Never an id or
 * a raw fingerprint. Pure.
 */

import type { Translator } from '@/lib/i18n'

import type { ProjectContextItem } from '../api'
import { formatVersion, kindLabelKey } from './referenceKinds'

/** The stores' `YYYY-MM-DD HH:MM:SS` (UTC) timestamps, or RFC 3339. */
export function parseStoreTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
]

/** "3 hours ago", in the app's language. */
export function relativeTime(date: Date, now: Date, locale: string | undefined): string {
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000)
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit)
  }
  return format.format(0, 'minute')
}

export function resultMeta(
  item: ProjectContextItem,
  t: Translator,
  options: { locale?: string; now?: Date; taskTitle?: (id: string) => string | undefined } = {},
): string[] {
  const parts = [t(kindLabelKey(item.ref.kind))]
  const version = formatVersion(item.ref.kind, item.ref.revision, t)
  if (version) parts.push(version)
  if (item.availability === 'removed') parts.push(t('kubecode.reference.state.removed'))
  const task = item.ref.kind !== 'research' && item.provenance.research_id
    ? options.taskTitle?.(item.provenance.research_id)
    : undefined
  if (task) parts.push(t('kubecode.search.inTask', { title: task }))
  const changed = parseStoreTimestamp(item.provenance.updated_at)
  if (changed) parts.push(relativeTime(changed, options.now ?? new Date(), options.locale))
  return parts
}
