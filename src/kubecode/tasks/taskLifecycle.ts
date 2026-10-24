/**
 * One Task lifecycle, as every view reads it (ADR 0230 §1): the stage is the
 * only state; what waits on the researcher, conditions, and archiving are
 * read from the same facts everywhere, so the board, the Task, and Needs you
 * say the same thing. Pure.
 */

import type { StatusTone } from '../statusTone'

import type { TaskBoard, TaskCard, TaskCondition, TaskDetail, TaskStage, TaskWorkRollup } from '../api'

export type TaskTab = 'overview' | 'results' | 'activity'

export type TaskNextStepKind =
  | 'archived' | 'draft' | 'approval' | 'review' | 'questions' | 'returned' | 'working' | 'ready' | 'done'
export type TaskNextStep = { kind: TaskNextStepKind; tone: StatusTone }

const TONES: Record<TaskNextStepKind, StatusTone> = {
  archived: 'muted',
  draft: 'muted',
  approval: 'warn',
  review: 'info',
  questions: 'warn',
  returned: 'warn',
  working: 'info',
  ready: 'info',
  done: 'ok',
}

const step = (kind: TaskNextStepKind): TaskNextStep => ({ kind, tone: TONES[kind] })

export function hasOpenReview(detail: TaskDetail | null): boolean {
  return Boolean(detail?.review_requests.some((request) => request.state === 'open'))
}

/**
 * What happens next, first match wins: archived, a proposal, a brief waiting
 * for approval, a review, a question, work sent back, work running, admitted,
 * done.
 */
export function nextStepOf(detail: TaskDetail | null, draft: boolean): TaskNextStep {
  if (detail?.archived) return step('archived')
  if (draft || !detail) return step('draft')
  if (detail.revision > detail.approved_revision) return step('approval')
  if (hasOpenReview(detail) || detail.stage === 'review') return step('review')
  if (detail.open_questions.length > 0) return step('questions')
  if (detail.stage === 'in_progress' && detail.last_event?.kind === 'review_returned') return step('returned')
  if (detail.stage === 'in_progress') return step('working')
  if (detail.stage === 'ready') return step('ready')
  return step('done')
}

/** What a card asks of the researcher: a review comes before a question. */
export function requiredActionOf(
  card: Pick<TaskCard, 'stage' | 'review_requested' | 'condition' | 'open_questions'>,
): 'review' | 'answer' | null {
  if (card.stage === 'review' && card.review_requested) return 'review'
  if (card.open_questions > 0) return 'answer'
  return null
}

export function conditionTone(condition: TaskCondition): StatusTone {
  switch (condition) {
    case 'needs_input': return 'warn'
    case 'blocked': return 'danger'
    default: return 'muted'
  }
}

/** A Task under review opens on its results; any other on its overview. */
export function defaultTabOf(detail: TaskDetail | null): TaskTab {
  return hasOpenReview(detail) ? 'results' : 'overview'
}

export function progressOf(work?: TaskWorkRollup): { done: number; total: number } | null {
  if (!work || work.total === 0) return null
  return { done: work.done, total: work.total }
}

const FIRST_STAGES: TaskStage[] = ['review', 'in_progress', 'ready', 'done']

/** The stage a narrow board shows first: the one that needs the researcher most. */
export function initialBoardStage(board: TaskBoard): TaskStage {
  return FIRST_STAGES.find((stage) => board.cards.some((card) => card.stage === stage)) ?? 'ready'
}

export function inspectedStage(board: TaskBoard | null, inspectedId: string | null): TaskStage | null {
  if (!board || !inspectedId) return null
  return board.cards.find((card) => card.id === inspectedId)?.stage ?? null
}
