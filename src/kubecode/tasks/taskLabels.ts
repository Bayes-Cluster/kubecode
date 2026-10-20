import type { WorkspaceObjectKind } from '@/kubecode/icons/workspaceIcons'
import type { Translator } from '@/lib/i18n'

import type { TaskCondition, TaskStage, WorkOutcome } from '../api'
import { isRoutableRecordKind, type InspectorRecordKind } from '../app/location/inspector'
import { messageDate } from '../channel/timeline'
import { PROJECT_CONTEXT_KIND_LABELS } from '../projectContext'
import { objectKindOf } from '../references/referenceLabels'

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

/** An outcome in words; `unknown` (not judged) has none. */
export function outcomeLabel(t: Translator, outcome: WorkOutcome | null | undefined): string | null {
  switch (outcome) {
    case 'supported': return t('kubecode.work.outcome.supported')
    case 'refuted': return t('kubecode.work.outcome.refuted')
    case 'inconclusive': return t('kubecode.work.outcome.inconclusive')
    default: return null
  }
}

/** When something happened, in the app's language; nothing for a time it cannot read. */
export function taskTime(createdAt: string | null | undefined, locale = 'en'): string {
  const date = createdAt ? messageDate(createdAt) : null
  return date ? date.toLocaleString(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''
}

/** What a cited record is, for its glyph and its kind in words. */
export function evidenceKind(t: Translator, kind: string): { kind: WorkspaceObjectKind; label: string } {
  if (kind === 'file') return { kind: 'file', label: t('kubecode.vocab.object.file') }
  if (isRoutableRecordKind(kind)) {
    return {
      kind: objectKindOf(kind),
      label: kind === 'research' ? t('kubecode.vocab.object.task') : t(PROJECT_CONTEXT_KIND_LABELS[kind]),
    }
  }
  return { kind: 'evidence', label: t('kubecode.vocab.object.evidence') }
}

/** The inspector kind a cited record opens as, or null for one it cannot show. */
export function recordKindOf(kind: string): InspectorRecordKind | null {
  return kind === 'file' || isRoutableRecordKind(kind) ? kind : null
}
