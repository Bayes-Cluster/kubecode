import { StatusBadge } from '@/components/workspace/StatusBadge'
import type { Translator } from '@/lib/i18n'

import type { TaskCard } from '../api'
import { conditionTone, requiredActionOf } from './taskLifecycle'
import { conditionLabel, outcomeLabel, stageLabel } from './taskLabels'

export type TaskStatusBadgesProps = {
  t: Translator
  /** An admitted Task's facts; absent for a proposal. */
  task?: Pick<
    TaskCard,
    'stage' | 'condition' | 'condition_reason' | 'revision' | 'approved_revision' | 'review_requested' | 'open_questions' | 'outcome'
  > | null
  archived?: boolean
  /** A proposal that is not on the board. */
  draft?: boolean
  /** On a card: the column already says the stage, and a condition's reason is its title. */
  compact?: boolean
}

/**
 * The one status vocabulary of a Task (ADR 0230 §1): its stage is its only
 * state; a condition, the action it asks of the researcher, a changed brief,
 * the accepted outcome and Archived are badges. Research Open/Resolved never
 * appears.
 */
export function TaskStatusBadges({ archived = false, compact = false, draft = false, t, task = null }: TaskStatusBadgesProps) {
  const condition = task ? conditionLabel(t, task.condition) : null
  const action = task ? requiredActionOf(task) : null
  const outcome = task?.stage === 'done' ? outcomeLabel(t, task.outcome) : null
  return (
    <span className="kubecode-task-badges">
      {draft && <StatusBadge tone="muted">{t('kubecode.task.draftBadge')}</StatusBadge>}
      {task && !compact && (
        <StatusBadge tone={task.stage === 'done' ? 'ok' : 'info'}>{stageLabel(t, task.stage)}</StatusBadge>
      )}
      {archived && <StatusBadge tone="muted">{t('kubecode.task.archivedBadge')}</StatusBadge>}
      {action && (
        <StatusBadge tone={action === 'review' ? 'info' : 'warn'}>
          {action === 'review' ? t('kubecode.task.action.review') : t('kubecode.task.action.answer')}
        </StatusBadge>
      )}
      {task && condition && (
        <StatusBadge title={compact ? task.condition_reason ?? undefined : undefined} tone={conditionTone(task.condition)}>
          {condition}
        </StatusBadge>
      )}
      {task && !compact && condition && task.condition_reason && (
        <span className="kubecode-task-condition-reason">{task.condition_reason}</span>
      )}
      {task && task.revision > task.approved_revision && (
        <StatusBadge tone="warn">{t('kubecode.task.briefChanged')}</StatusBadge>
      )}
      {outcome && <StatusBadge tone="ok">{outcome}</StatusBadge>}
    </span>
  )
}
