import { StatusBadge } from '@/components/workspace/StatusBadge'
import type { Translator } from '@/lib/i18n'

import type { ResearchSourceAvailability } from '../api'
import { availabilityLabel } from './researchLabels'

/**
 * A source's current state. A removed or changed source is called out so
 * evidence never looks like it still proves what it did when it was cited.
 */
export function AvailabilityBadge({
  availability,
  t,
}: {
  availability: ResearchSourceAvailability
  t: Translator
}) {
  return (
    <StatusBadge tone={availability === 'available' ? 'ok' : 'warn'}>
      {availabilityLabel(t, availability)}
    </StatusBadge>
  )
}

export function StaleBadge({ t }: { t: Translator }) {
  return (
    <StatusBadge tone="warn" title={t('kubecode.research.staleHint')}>
      {t('kubecode.research.stale')}
    </StatusBadge>
  )
}
