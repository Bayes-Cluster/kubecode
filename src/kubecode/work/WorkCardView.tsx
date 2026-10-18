import { AlertCircle, FlaskConical, GitBranch, MessageSquareText, Repeat2 } from 'lucide-react'

import { AiAgentIcon } from '@/components/AiAgentIcon'
import type { Translator } from '@/lib/i18n'
import { cn } from '@/lib/utils'

import type { WorkCard } from '../api'
import { CONDITION_LABELS, LIFECYCLE_LABELS } from './workModel'

export type WorkCardViewProps = {
  card: WorkCard
  draggable: boolean
  selected: boolean
  onDragStart: (card: WorkCard) => void
  onDragEnd: () => void
  onSelect: (card: WorkCard) => void
  t: Translator
}

/**
 * One work item. Retries stay under this card (the attempt count), valid
 * negative results and accepted delivery are marked differently from a failed
 * run, and waits, blockers, pauses, and human-input needs read separately from
 * the stage the card sits in.
 */
export function WorkCardView({
  card,
  draggable,
  onDragEnd,
  onDragStart,
  onSelect,
  selected,
  t,
}: WorkCardViewProps) {
  const { item } = card
  const condition = item.condition === 'none' ? null : item.condition
  const dependencyBlockers = card.blockers.filter((blocker) => blocker.kind === 'dependency')
  const failed = card.latest_attempt?.status === 'failed'
  const closed = item.lifecycle !== 'active'
  return (
    <article
      aria-current={selected ? 'true' : undefined}
      className={cn('kubecode-work-card', selected && 'is-selected')}
      data-acceptance={item.acceptance}
      data-condition={item.condition}
      data-lifecycle={item.lifecycle}
      data-outcome={item.outcome}
      data-testid={`work-card-${item.id}`}
      draggable={draggable}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(card)}
      onDragEnd={onDragEnd}
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', item.id)
        event.dataTransfer.effectAllowed = 'move'
        onDragStart(card)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect(card)
        }
      }}
    >
      <strong>{item.title}</strong>
      {card.research && (
        <small className="kubecode-work-card-context">
          {card.research.title}
          {card.round ? ` · ${t('kubecode.work.roundNumber', { round: card.round.number })}` : ''}
        </small>
      )}
      <div className="kubecode-work-card-badges">
        {closed && (
          <span className="kubecode-research-badge" data-tone="muted">
            {t(LIFECYCLE_LABELS[item.lifecycle as keyof typeof LIFECYCLE_LABELS])}
          </span>
        )}
        {condition && (
          <span className="kubecode-research-badge" data-tone={condition === 'needs_input' ? 'warn' : 'info'}>
            {t(CONDITION_LABELS[condition])}
          </span>
        )}
        {item.acceptance === 'accepted' && (
          <span className="kubecode-research-badge" data-tone="ok">{t('kubecode.work.acceptance.accepted')}</span>
        )}
        {item.acceptance === 'rejected' && item.stage !== 'done' && (
          <span className="kubecode-research-badge" data-tone="warn">{t('kubecode.work.acceptance.rejected')}</span>
        )}
        {item.outcome === 'refuted' && (
          <span className="kubecode-research-badge" data-tone="ok">{t('kubecode.work.outcome.refuted')}</span>
        )}
        {item.outcome === 'inconclusive' && (
          <span className="kubecode-research-badge" data-tone="muted">{t('kubecode.work.outcome.inconclusive')}</span>
        )}
        {failed && !closed && (
          <span className="kubecode-research-badge" data-tone="warn">
            <AlertCircle aria-hidden size={12} /> {t('kubecode.work.attemptFailed')}
          </span>
        )}
        {card.operable === 'legacy_team' && (
          <span className="kubecode-research-badge" data-tone="muted">{t('kubecode.work.legacy')}</span>
        )}
        {card.delivery?.state === 'failed' && (
          <span className="kubecode-research-badge" data-tone="warn">{t('kubecode.work.delivery.failed')}</span>
        )}
        {card.delivery?.state === 'pending' && (
          <span className="kubecode-research-badge" data-tone="info">{t('kubecode.work.delivery.pending')}</span>
        )}
      </div>
      {dependencyBlockers.length > 0 && (
        <small className="kubecode-work-card-blocker">
          <GitBranch aria-hidden size={12} />
          {dependencyBlockers[0].kind === 'dependency' && dependencyBlockers[0].closed
            ? t('kubecode.work.dependencyClosed', { title: dependencyBlockers[0].title })
            : t('kubecode.work.waitingFor', {
              title: dependencyBlockers[0].kind === 'dependency' ? dependencyBlockers[0].title : '',
            })}
          {dependencyBlockers.length > 1 ? ` +${dependencyBlockers.length - 1}` : ''}
        </small>
      )}
      {item.condition_reason && condition && (
        <small className="kubecode-work-card-blocker">{item.condition_reason}</small>
      )}
      <footer>
        {card.executor ? (
          <span className="kubecode-work-card-agent">
            {card.executor.agent_id && <AiAgentIcon agent={card.executor.agent_id} size={14} />}
            <span>{card.executor.title}</span>
          </span>
        ) : (
          <span className="kubecode-work-card-agent">{t('kubecode.work.unassigned')}</span>
        )}
        <span className="kubecode-work-card-counts">
          {card.attempt_count > 1 && (
            <span title={t('kubecode.work.attempts', { count: card.attempt_count })}>
              <Repeat2 aria-hidden size={12} /> {card.attempt_count}
            </span>
          )}
          {card.experiment_count > 0 && (
            <span title={t('kubecode.work.experiments', { count: card.experiment_count })}>
              <FlaskConical aria-hidden size={12} /> {card.experiment_count}
            </span>
          )}
          {card.origin_thread && (
            <span title={card.origin_thread.title}>
              <MessageSquareText aria-hidden size={12} />
            </span>
          )}
        </span>
      </footer>
    </article>
  )
}
