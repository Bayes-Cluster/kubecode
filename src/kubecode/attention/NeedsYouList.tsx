import { useId, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item'
import { Spinner } from '@/components/ui/spinner'
import type { Translator } from '@/lib/i18n'


import type { NeedsYouEntry, NeedsYouTarget } from '../app/location/needsYou'
import { ReaderNotice } from '../resources/ReaderStates'
import { statusToneVariant } from '../statusTone'

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
    <div className="flex flex-col gap-1">
      <h3 className="px-2 text-xs font-medium text-muted-foreground" id={heading}>{label}</h3>
      <ItemGroup aria-labelledby={heading} className="gap-1" role="list">
        {entries.map((entry) => {
          const resolving = entry.state === 'resolving'
          return (
            <div key={entry.key} role="listitem">
              {/* The official Item is the row's one button (#259): it opens the context holding the request. */}
              <Item asChild className="w-full text-left" size="sm">
                <button
                  aria-busy={resolving || undefined}
                  data-attention-key={entry.key}
                  data-state={entry.state ?? 'waiting'}
                  type="button"
                  onClick={() => onOpenTarget(entry.target)}
                >
                  <ItemContent className="min-w-0">
                    <ItemTitle className="[overflow-wrap:anywhere]">{entry.title}</ItemTitle>
                    {(resolving || entry.detail) && (
                      <ItemDescription className="line-clamp-none [overflow-wrap:anywhere]">
                        {resolving ? t('kubecode.attention.resolving') : entry.detail}
                      </ItemDescription>
                    )}
                  </ItemContent>
                  <ItemActions>
                    {resolving
                      ? <Spinner aria-hidden aria-label={undefined} className="motion-reduce:animate-none" role={undefined} />
                      : <Badge variant={statusToneVariant(entry.reason.tone)}>{entry.reason.label}</Badge>}
                  </ItemActions>
                </button>
              </Item>
            </div>
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
    <div className="kubecode-needs-you-list flex flex-col gap-3">
      {/* No live region of its own: the shell announces what newly waits (ADR 0234). */}
      {status === 'loading' && entries.length === 0 && (
        <div className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
          <Spinner aria-hidden aria-label={undefined} role={undefined} />
          <span>{t('kubecode.nav.needsYouLoading')}</span>
        </div>
      )}
      {status === 'ready' && !incomplete && entries.length === 0 && (
        <Empty size="compact">
          <EmptyHeader>
            <EmptyDescription>{t('kubecode.nav.needsYouNone')}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {failed && (
        <ReaderNotice
          action={<Button size="xs" variant="outline" onClick={onRetryLoad}>{t('kubecode.vocab.command.retry')}</Button>}
          live={false}
        >
          {t('kubecode.nav.needsYouIncomplete')}
        </ReaderNotice>
      )}
      <Rows entries={decisions} label={t('kubecode.nav.groupDecisions')} t={t} onOpenTarget={onOpenTarget} />
      <Rows entries={setup} label={t('kubecode.nav.groupSetup')} t={t} onOpenTarget={onOpenTarget} />
      {!all && entries.length > SHOWN && (
        <Button className="self-start" size="xs" variant="ghost" onClick={() => setAll(true)}>
          {t('kubecode.nav.needsYouShowAll', { count: entries.length })}
        </Button>
      )}
    </div>
  )
}
