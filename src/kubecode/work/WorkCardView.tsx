import { AlertCircle, FlaskConical, GitBranch, MessageSquareText, Repeat2 } from 'lucide-react'

import { AgxBoardCard } from '@/components/agent-ui'
import { Badge } from '@/components/ui/badge'
import { AiAgentIcon } from '@/components/AiAgentIcon'
import type { Translator } from '@/lib/i18n'

import type { WorkCard } from '../api'
import { CONDITION_LABELS, LIFECYCLE_LABELS } from './workModel'
import { statusToneVariant } from '../statusTone'

export type WorkCardViewProps = {
  card: WorkCard
  /** This card is the one being dragged across the board. */
  dragging?: boolean
  draggable: boolean
  selected: boolean
  onDragStart: (card: WorkCard) => void
  onDragEnd: () => void
  onSelect: (card: WorkCard) => void
  t: Translator
}

/**
 * One work item, on the shared board presentation (ADR 0257, #284). Retries
 * stay under this card (the attempt count), valid negative results and
 * accepted delivery are marked differently from a failed run, and waits,
 * blockers, pauses, and human-input needs read separately from the stage the
 * card sits in. The shell owns the frame and the drag states; the button
 * inside opens the item and carries focus and the inspected ring.
 */
export function WorkCardView({
  card,
  dragging = false,
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
    <AgxBoardCard data-testid={`work-card-shell-${item.id}`} dragging={dragging}>
    <button
      aria-current={selected ? 'true' : undefined}
      className="agx-board__card-body kubecode-work-card cursor-pointer text-left ring-inset outline-none focus-visible:ring-[3px] focus-visible:ring-ring aria-[current=true]:ring-2 aria-[current=true]:ring-primary"
      data-acceptance={item.acceptance}
      data-condition={item.condition}
      data-lifecycle={item.lifecycle}
      data-outcome={item.outcome}
      data-testid={`work-card-${item.id}`}
      draggable={draggable}
      type="button"
      onClick={() => onSelect(card)}
      onDragEnd={onDragEnd}
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', item.id)
        event.dataTransfer.effectAllowed = 'move'
        onDragStart(card)
      }}
    >
      <span className="kubecode-work-card-title">{item.title}</span>
      {item.description && (
        <small className="agx-board__card-secondary kubecode-work-card-objective">{clip(item.description, 110)}</small>
      )}
      {card.research && (
        <small className="agx-board__card-secondary kubecode-work-card-context">
          {card.research.title}
          {card.round ? ` · ${t('kubecode.work.roundNumber', { round: card.round.number })}` : ''}
        </small>
      )}
      <span className="kubecode-work-card-badges">
        {closed && (
          <Badge variant="secondary">
            {t(LIFECYCLE_LABELS[item.lifecycle as keyof typeof LIFECYCLE_LABELS])}
          </Badge>
        )}
        {condition && (
          <Badge variant={statusToneVariant(condition === 'needs_input' ? 'warn' : 'info')}>
            {t(CONDITION_LABELS[condition])}
          </Badge>
        )}
        {item.acceptance === 'accepted' && (
          <Badge variant="success">{t('kubecode.work.acceptance.accepted')}</Badge>
        )}
        {item.acceptance === 'rejected' && item.stage !== 'done' && (
          <Badge variant="warning">{t('kubecode.work.acceptance.rejected')}</Badge>
        )}
        {item.outcome === 'refuted' && (
          <Badge variant="success">{t('kubecode.work.outcome.refuted')}</Badge>
        )}
        {item.outcome === 'inconclusive' && (
          <Badge variant="secondary">{t('kubecode.work.outcome.inconclusive')}</Badge>
        )}
        {failed && !closed && (
          <Badge variant="warning">
            <AlertCircle aria-hidden size={12} /> {t('kubecode.work.attemptFailed')}
          </Badge>
        )}
        {card.operable === 'legacy_team' && (
          <Badge variant="secondary">{t('kubecode.work.legacy')}</Badge>
        )}
        {card.delivery?.state === 'failed' && (
          <Badge variant="warning">{t('kubecode.work.delivery.failed')}</Badge>
        )}
        {card.delivery?.state === 'pending' && (
          <Badge variant="info">{t('kubecode.work.delivery.pending')}</Badge>
        )}
      </span>
      {dependencyBlockers.length > 0 && (
        <small className="agx-board__card-secondary kubecode-work-card-blocker">
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
        <small className="agx-board__card-secondary kubecode-work-card-blocker">{item.condition_reason}</small>
      )}
      {closed && item.closed_reason && (
        <small className="agx-board__card-secondary kubecode-work-card-blocker">
          {t('kubecode.work.closedReason', { reason: item.closed_reason })}
        </small>
      )}
      {progress(card, t) && (
        <small className="agx-board__card-secondary kubecode-work-card-progress">{progress(card, t)}</small>
      )}
      <span className="kubecode-work-card-footer">
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
      </span>
    </button>
    </AgxBoardCard>
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
