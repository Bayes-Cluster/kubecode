import { Badge } from '@/components/ui/badge'
import type { Translator } from '@/lib/i18n'
import { cn } from '@/lib/utils'

import type { TaskCard } from '../api'
import { conditionTone, requiredActionOf } from './taskLifecycle'
import { conditionLabel, conditionReason, outcomeLabel, stageLabel } from './taskLabels'
import { statusToneVariant } from '../statusTone'

export type TaskStatusBadgesProps = {
  t: Translator
  /** An admitted Task's facts; absent for a proposal. */
  task?: Pick<
    TaskCard,
    'stage' | 'condition' | 'revision' | 'approved_revision' | 'review_requested' | 'open_questions' | 'outcome'
  > | null
  archived?: boolean
  /** A proposal that is not on the board. */
  draft?: boolean
  /** On a card: the column already says the stage. A condition's reason is shown as text either way, so touch reaches it. */
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
  const reason = task ? conditionReason(t, task.condition) : null
  const action = task ? requiredActionOf(task) : null
  const outcome = task?.stage === 'done' ? outcomeLabel(t, task.outcome) : null
  return (
    <span className="flex flex-wrap items-center gap-1">
      {draft && <Badge variant="secondary">{t('kubecode.task.draftBadge')}</Badge>}
      {task && !compact && (
        <Badge variant={statusToneVariant(task.stage === 'done' ? 'ok' : 'info')}>{stageLabel(t, task.stage)}</Badge>
      )}
      {archived && <Badge variant="secondary">{t('kubecode.task.archivedBadge')}</Badge>}
      {action && (
        <Badge variant={statusToneVariant(action === 'review' ? 'info' : 'warn')}>
          {action === 'review' ? t('kubecode.task.action.review') : t('kubecode.task.action.answer')}
        </Badge>
      )}
      {task && condition && <Badge variant={statusToneVariant(conditionTone(task.condition))}>{condition}</Badge>}
      {reason && <span className={cn('text-xs text-muted-foreground [overflow-wrap:anywhere]', compact && 'basis-full')}>{reason}</span>}
      {task && task.revision > task.approved_revision && (
        <Badge variant="warning">{t('kubecode.task.briefChanged')}</Badge>
      )}
      {outcome && <Badge variant="success">{outcome}</Badge>}
    </span>
  )
}
