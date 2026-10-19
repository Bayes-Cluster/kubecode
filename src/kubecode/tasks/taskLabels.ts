import type { Translator } from '@/lib/i18n'

import type { TaskCondition, TaskStage } from '../api'

type Key = Parameters<Translator>[0]

export const TASK_STAGES: TaskStage[] = ['ready', 'in_progress', 'review', 'done']

const STAGE_LABELS: Record<TaskStage, Key> = {
  ready: 'kubecode.task.stage.ready',
  in_progress: 'kubecode.task.stage.in_progress',
  review: 'kubecode.task.stage.review',
  done: 'kubecode.task.stage.done',
}

const CONDITION_LABELS: Record<Exclude<TaskCondition, 'none'>, Key> = {
  waiting: 'kubecode.work.condition.waiting',
  blocked: 'kubecode.work.condition.blocked',
  paused: 'kubecode.work.condition.paused',
  needs_input: 'kubecode.work.condition.needsInput',
}

export function stageLabel(t: Translator, stage: TaskStage): string {
  return t(STAGE_LABELS[stage])
}

/** A condition is why a Task is not moving; it is never a stage. `none` has no label. */
export function conditionLabel(t: Translator, condition: TaskCondition): string | null {
  return condition === 'none' ? null : t(CONDITION_LABELS[condition])
}
