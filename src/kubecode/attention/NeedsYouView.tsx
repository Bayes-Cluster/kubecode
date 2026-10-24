import { useId } from 'react'

import { Badge } from '@/components/ui/badge'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item'
import type { StatusTone } from '../statusTone'
import type { Translator } from '@/lib/i18n'

import type { ManagerDecision } from '../api'

import { DestinationHeader } from '../app/DestinationHeader'
import type { NeedsYouEntry, NeedsYouTarget } from '../app/location/needsYou'
import { NeedsYouList } from './NeedsYouList'
import { statusToneVariant } from '../statusTone'

export type NeedsYouViewProps = {
  entries: NeedsYouEntry[]
  status: 'loading' | 'ready' | 'error'
  incomplete: boolean
  /** What the project manager decided on specialists' permission requests (ADR 0237). */
  managerDecisions?: ManagerDecision[]
  t: Translator
  onOpenTarget: (target: NeedsYouTarget) => void
  onRetryLoad: () => void
}

const DECISION_TONE: Record<ManagerDecision['decision'], StatusTone> = {
  approved: 'ok',
  denied: 'muted',
  escalated: 'warn',
}

/** The manager's own words, or the server's reason code worded here. */
function reasonOf(decision: ManagerDecision, t: Translator): string {
  if (decision.decided_by !== 'system') return decision.reason
  return decision.reason === 'timeout'
    ? t('kubecode.needsYou.managerDecisions.systemTimeout')
    : t('kubecode.needsYou.managerDecisions.systemUnreachable')
}

/** The manager's decisions, shown afterwards as information: nothing here is answered. */
function ManagerDecisions({ decisions, t }: { decisions: ManagerDecision[]; t: Translator }) {
  const heading = useId()
  if (decisions.length === 0) return null
  return (
    <div className="flex flex-col gap-1">
      <h3 className="px-2 text-xs font-medium text-muted-foreground" id={heading}>{t('kubecode.needsYou.managerDecisions.title')}</h3>
      <ItemGroup aria-labelledby={heading} className="gap-1" role="list">
        {decisions.map((decision) => (
          <Item
            data-decision={decision.decision}
            key={decision.id}
            role="listitem"
            size="sm"
          >
            <ItemContent className="min-w-0">
              <ItemTitle className="[overflow-wrap:anywhere]">
                {t('kubecode.needsYou.managerDecisions.summary', {
                  member: decision.member?.name ?? t('kubecode.needsYou.managerDecisions.someone'),
                  tool: decision.tool,
                })}
              </ItemTitle>
              <ItemDescription className="line-clamp-none [overflow-wrap:anywhere]">
                {t('kubecode.needsYou.managerDecisions.reason', { reason: reasonOf(decision, t) })}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Badge variant={statusToneVariant(DECISION_TONE[decision.decision])}>
                {t(`kubecode.needsYou.managerDecisions.${decision.decision}`)}
              </Badge>
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
    </div>
  )
}

/**
 * Needs you as a Workspace destination (ADR 0234): the same header as
 * General, Kanban, Resources and Members, then every decision and setup item
 * that waits, each opening where it is answered, then what the project
 * manager decided for the researcher to read. It hosts no inspector.
 */
export function NeedsYouView({ entries, incomplete, managerDecisions = [], onOpenTarget, onRetryLoad, status, t }: NeedsYouViewProps) {
  return (
    <section aria-label={t('kubecode.nav.needsYou')} className="kubecode-needs-you-view">
      <DestinationHeader description={t('kubecode.nav.needsYouDescription')} destination="needs-you" t={t} />
      <div className="kubecode-destination-body flex flex-col gap-4">
        <NeedsYouList
          entries={entries}
          incomplete={incomplete}
          showAll
          status={status}
          t={t}
          onOpenTarget={onOpenTarget}
          onRetryLoad={onRetryLoad}
        />
        <ManagerDecisions decisions={managerDecisions} t={t} />
      </div>
    </section>
  )
}
