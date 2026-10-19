import { AlertCircle, FlaskConical, GitBranch, MessageSquareText, Repeat2 } from 'lucide-react'

import { StatusBadge } from '@/components/workspace/StatusBadge'
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
      {item.description && (
        <small className="kubecode-work-card-objective">{clip(item.description, 110)}</small>
      )}
      {card.research && (
        <small className="kubecode-work-card-context">
          {card.research.title}
          {card.round ? ` · ${t('kubecode.work.roundNumber', { round: card.round.number })}` : ''}
        </small>
      )}
      <div className="kubecode-work-card-badges">
        {closed && (
          <StatusBadge tone="muted">
            {t(LIFECYCLE_LABELS[item.lifecycle as keyof typeof LIFECYCLE_LABELS])}
          </StatusBadge>
        )}
        {condition && (
          <StatusBadge tone={condition === 'needs_input' ? 'warn' : 'info'}>
            {t(CONDITION_LABELS[condition])}
          </StatusBadge>
        )}
        {item.acceptance === 'accepted' && (
          <StatusBadge tone="ok">{t('kubecode.work.acceptance.accepted')}</StatusBadge>
        )}
        {item.acceptance === 'rejected' && item.stage !== 'done' && (
          <StatusBadge tone="warn">{t('kubecode.work.acceptance.rejected')}</StatusBadge>
        )}
        {item.outcome === 'refuted' && (
          <StatusBadge tone="ok">{t('kubecode.work.outcome.refuted')}</StatusBadge>
        )}
        {item.outcome === 'inconclusive' && (
          <StatusBadge tone="muted">{t('kubecode.work.outcome.inconclusive')}</StatusBadge>
        )}
        {failed && !closed && (
          <StatusBadge tone="warn">
            <AlertCircle aria-hidden size={12} /> {t('kubecode.work.attemptFailed')}
          </StatusBadge>
        )}
        {card.operable === 'legacy_team' && (
          <StatusBadge tone="muted">{t('kubecode.work.legacy')}</StatusBadge>
        )}
        {card.delivery?.state === 'failed' && (
          <StatusBadge tone="warn">{t('kubecode.work.delivery.failed')}</StatusBadge>
        )}
        {card.delivery?.state === 'pending' && (
          <StatusBadge tone="info">{t('kubecode.work.delivery.pending')}</StatusBadge>
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
      {closed && item.closed_reason && (
        <small className="kubecode-work-card-blocker">
          {t('kubecode.work.closedReason', { reason: item.closed_reason })}
        </small>
      )}
      {progress(card, t) && (
        <small className="kubecode-work-card-progress">{progress(card, t)}</small>
      )}
      <footer>
        {card.executor ? (
          <span className="kubecode-work-card-agent">
            {card.executor.agent_id && <AiAgentIcon agent={card.executor.agent_id} size={14} />}
            <span>
              {card.executor.available ? card.executor.title : t('kubecode.work.executorRemoved')}
            </span>
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

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** The latest meaningful progress: the result if there is one, else the newest attempt's state. */
function progress(card: WorkCard, t: Translator): string | null {
  if (card.item.result) return clip(card.item.result, 110)
  const attempt = card.latest_attempt
  if (!attempt) return null
  return t('kubecode.work.latestAttempt', {
    status: t(`kubecode.work.attemptStatus.${attempt.status}` as 'kubecode.work.attemptStatus.queued'),
  })
}
