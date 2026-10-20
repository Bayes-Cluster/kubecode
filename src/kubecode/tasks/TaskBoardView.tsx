import { useRef } from 'react'

import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/workspace/StatusBadge'
import type { Translator } from '@/lib/i18n'

import type { TaskBoard, TaskCard, TaskDraft } from '../api'
import { useScrollMemory } from '../app/location/placeMemory'
import type { TaskBoardStatus } from './useTaskBoard'
import { conditionLabel, stageLabel, TASK_STAGES } from './taskLabels'

export type TaskBoardViewProps = {
  board: TaskBoard | null
  drafts: TaskDraft[]
  /** The Task open in the detail pane, marked on its card. */
  selectedId?: string | null
  status: TaskBoardStatus
  t: Translator
  onOpenDraft: (draft: TaskDraft) => void
  onOpenTask: (task: TaskCard) => void
  onReload: () => void
  /** Where the board's scroll position is kept for the place (`placeKey.view`). */
  scrollKey?: string | null
}

/**
 * The Workspace's one board: admitted, top-level Tasks in Ready, In progress,
 * Review, and Done. Waiting, blocked, paused, and needs-input are conditions
 * shown on a card, never columns, and nothing here admits a Task: that is the
 * General Agent's act on the researcher's words in General (ADR 0221).
 */
export function TaskBoardView({
  board,
  drafts,
  onOpenDraft,
  onOpenTask,
  onReload,
  scrollKey = null,
  selectedId = null,
  status,
  t,
}: TaskBoardViewProps) {
  const scroller = useRef<HTMLElement>(null)
  useScrollMemory(scroller, scrollKey, { ready: board !== null })
  return (
    <section aria-label={t('kubecode.nav.board')} className="kubecode-task-board" ref={scroller}>
      <header className="kubecode-channel-header">
        <div>
          <h2>{t('kubecode.nav.board')}</h2>
          <p className="kubecode-research-muted">{t('kubecode.task.boardSubtitle')}</p>
        </div>
      </header>
      {status === 'error' && (
        <p className="kubecode-research-error" role="alert">
          {t('kubecode.task.loadFailed')}{' '}
          <Button size="xs" variant="ghost" onClick={onReload}>{t('kubecode.retry')}</Button>
        </p>
      )}
      {status === 'loading' && (
        <p className="kubecode-research-muted" role="status">{t('kubecode.task.loading')}</p>
      )}
      {board && (
        <div className="kubecode-task-columns">
          {TASK_STAGES.map((stage) => {
            const cards = board.cards.filter((card) => card.stage === stage)
            return (
              <section
                aria-label={stageLabel(t, stage)}
                className="kubecode-task-column"
                data-stage={stage}
                key={stage}
              >
                <h3>
                  {stageLabel(t, stage)}
                  <StatusBadge tone="muted">{cards.length}</StatusBadge>
                </h3>
                {cards.length === 0 && <p className="kubecode-research-muted">{t('kubecode.task.columnEmpty')}</p>}
                <ul>
                  {cards.map((card) => {
                    const condition = conditionLabel(t, card.condition)
                    const manager = card.participants.find((member) => member.role === 'general')
                    const specialists = card.participants.filter((member) => member.role !== 'general')
                    return (
                      <li key={card.id}>
                        <button
                          aria-current={selectedId === card.id ? 'true' : undefined}
                          className="kubecode-task-card"
                          data-focus-key={`card:${card.id}`}
                          data-scroll-anchor={`card:${card.id}`}
                          data-testid={`task-card-${card.id}`}
                          type="button"
                          onClick={() => onOpenTask(card)}
                        >
                          <strong>{card.title}</strong>
                          <span className="kubecode-task-card-badges">
                            {condition && (
                              <StatusBadge title={card.condition_reason ?? undefined} tone="warn">{condition}</StatusBadge>
                            )}
                            {card.review_requested && card.stage === 'review' && (
                              <StatusBadge tone="info">{t('kubecode.task.awaitingYou')}</StatusBadge>
                            )}
                            {card.revision > card.approved_revision && (
                              <StatusBadge tone="warn">{t('kubecode.task.briefChanged')}</StatusBadge>
                            )}
                          </span>
                          <small>
                            {manager && `${t('kubecode.task.manager')}: @${manager.handle}`}
                            {manager && specialists.length > 0 && ' · '}
                            {specialists.map((member) => `@${member.handle}`).join(' ')}
                          </small>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
        </div>
      )}
      {drafts.length > 0 && (
        <details className="kubecode-task-drafts">
          <summary>{t('kubecode.task.proposals', { count: drafts.length })}</summary>
          <p className="kubecode-research-muted">{t('kubecode.task.proposalsHint')}</p>
          <ul>
            {drafts.map((draft) => (
              <li key={draft.id}>
                <button className="kubecode-research-nav-item" type="button" onClick={() => onOpenDraft(draft)}>
                  <span className="kubecode-research-nav-title">{draft.title}</span>
                  <StatusBadge tone="muted">{t('kubecode.task.revision', { revision: draft.revision })}</StatusBadge>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
