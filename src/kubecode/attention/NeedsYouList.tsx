import { Loader2 } from 'lucide-react'
import { useId, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription } from '@/components/ui/empty'
import { Item, ItemGroup } from '@/components/ui/item'
import type { Translator } from '@/lib/i18n'

import { ToneBadge } from '../tasks/ToneBadge'

import type { NeedsYouEntry, NeedsYouTarget } from '../app/location/needsYou'

const SHOWN = 6

export type NeedsYouListProps = {
  entries: NeedsYouEntry[]
  status: 'loading' | 'ready' | 'error'
  /** A source could not be read: the list may be missing items, so it is never called empty. */
  incomplete: boolean
  t: Translator
  onOpenTarget: (target: NeedsYouTarget) => void
  onRetryLoad: () => void
  /** Every entry at once, as the Needs you view shows them; otherwise the first few and "Show all". */
  showAll?: boolean
}

function Rows({ entries, label, onOpenTarget, t }: {
  entries: NeedsYouEntry[]
  label: string
  onOpenTarget: (target: NeedsYouTarget) => void
  t: Translator
}) {
  const heading = useId()
  if (entries.length === 0) return null
  return (
    <div className="kubecode-needs-you-group">
      <h3 className="kubecode-nav-heading" id={heading}>{label}</h3>
      <ItemGroup aria-labelledby={heading} className="kubecode-research-nav-list">
        {entries.map((entry) => {
          const resolving = entry.state === 'resolving'
          return (
            <Item className="kubecode-needs-you-item" key={entry.key} role="listitem" size="sm">
              <button
                aria-busy={resolving || undefined}
                className="kubecode-research-nav-item kubecode-needs-you-row"
                data-attention-key={entry.key}
                data-state={entry.state ?? 'waiting'}
                type="button"
                onClick={() => onOpenTarget(entry.target)}
              >
                <span className="kubecode-needs-you-text">
                  <span className="kubecode-needs-you-title">{entry.title}</span>
                  {(resolving || entry.detail) && (
                    <span className="kubecode-needs-you-detail">
                      {resolving ? t('kubecode.attention.resolving') : entry.detail}
                    </span>
                  )}
                </span>
                {resolving
                  ? <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" size={14} />
                  : <ToneBadge tone={entry.reason.tone}>{entry.reason.label}</ToneBadge>}
              </button>
            </Item>
          )
        })}
      </ItemGroup>
    </div>
  )
}

/**
 * What waits for the researcher (ADR 0232): decisions, then setup, each row
 * one button that opens the context holding it. An answered row stays, busy,
 * until the server's next snapshot drops it; a list that could not be read
 * completely says so instead of claiming nothing waits. What newly waits, or
 * left, is announced by the shell (`useNeedsYouAnnouncement`), not here: this
 * list is on screen only while the Needs you view is (ADR 0234).
 */
export function NeedsYouList({ entries, incomplete, onOpenTarget, onRetryLoad, showAll = false, status, t }: NeedsYouListProps) {
  const [expanded, setAll] = useState(false)
  const all = showAll || expanded
  const shown = all ? entries : entries.slice(0, SHOWN)
  const decisions = shown.filter((entry) => entry.group !== 'setup')
  const setup = shown.filter((entry) => entry.group === 'setup')
  const failed = status === 'error' || incomplete


  return (
    <div className="kubecode-needs-you-list" data-ws-components="official">
      {status === 'loading' && entries.length === 0 && (
        <p className="kubecode-research-nav-note">{t('kubecode.nav.needsYouLoading')}</p>
      )}
      {status === 'ready' && !incomplete && entries.length === 0 && (
        <Empty className="kubecode-needs-you-empty">
          <EmptyDescription>{t('kubecode.nav.needsYouNone')}</EmptyDescription>
        </Empty>
      )}
      {failed && (
        <p className="kubecode-research-nav-note" data-tone="warn">
          {t('kubecode.nav.needsYouIncomplete')}{' '}
          <Button size="xs" variant="ghost" onClick={onRetryLoad}>{t('kubecode.vocab.command.retry')}</Button>
        </p>
      )}
      <Rows entries={decisions} label={t('kubecode.nav.groupDecisions')} t={t} onOpenTarget={onOpenTarget} />
      <Rows entries={setup} label={t('kubecode.nav.groupSetup')} t={t} onOpenTarget={onOpenTarget} />
      {!all && entries.length > SHOWN && (
        <Button size="xs" variant="ghost" onClick={() => setAll(true)}>
          {t('kubecode.nav.needsYouShowAll', { count: entries.length })}
        </Button>
      )}
    </div>
  )
}
