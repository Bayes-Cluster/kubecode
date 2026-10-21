import type { Translator } from '@/lib/i18n'

import { DestinationHeader } from '../app/DestinationHeader'
import type { NeedsYouEntry, NeedsYouTarget } from '../app/location/needsYou'
import { NeedsYouList } from './NeedsYouList'

export type NeedsYouViewProps = {
  entries: NeedsYouEntry[]
  status: 'loading' | 'ready' | 'error'
  incomplete: boolean
  t: Translator
  onOpenTarget: (target: NeedsYouTarget) => void
  onRetryLoad: () => void
}

/**
 * Needs you as a Workspace destination (ADR 0234): the same header as
 * General, Kanban, Resources and Members, then every decision and setup item
 * that waits, each opening where it is answered. It hosts no inspector.
 */
export function NeedsYouView({ entries, incomplete, onOpenTarget, onRetryLoad, status, t }: NeedsYouViewProps) {
  return (
    <section aria-label={t('kubecode.nav.needsYou')} className="kubecode-needs-you-view">
      <DestinationHeader description={t('kubecode.nav.needsYouDescription')} destination="needs-you" t={t} />
      <div className="kubecode-destination-body">
        <NeedsYouList
          entries={entries}
          incomplete={incomplete}
          showAll
          status={status}
          t={t}
          onOpenTarget={onOpenTarget}
          onRetryLoad={onRetryLoad}
        />
      </div>
    </section>
  )
}
