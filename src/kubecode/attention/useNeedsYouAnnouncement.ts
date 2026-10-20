import { useState } from 'react'

import type { Translator } from '@/lib/i18n'

import type { NeedsYouEntry } from '../app/location/needsYou'

/**
 * What to announce about Needs you (ADR 0232): a decision that newly needs the
 * researcher, or one they answered that the server has since dropped. The
 * shell speaks it in its always-mounted status region, so it is heard while
 * Needs you is folded away or the navigation sheet is closed.
 */
export function useNeedsYouAnnouncement(entries: NeedsYouEntry[], t: Translator): string {
  const [seen, setSeen] = useState<NeedsYouEntry[]>(entries)
  const [announcement, setAnnouncement] = useState('')
  if (seen !== entries) {
    const before = new Map(seen.map((entry) => [entry.key, entry]))
    const now = new Set(entries.map((entry) => entry.key))
    const added = entries.find((entry) => !before.has(entry.key))
    const resolved = seen.find((entry) => entry.state === 'resolving' && !now.has(entry.key))
    setSeen(entries)
    if (resolved) setAnnouncement(t('kubecode.attention.resolved', { title: resolved.title }))
    else if (added) setAnnouncement(t('kubecode.attention.newItem', { title: added.title }))
  }
  return announcement
}
