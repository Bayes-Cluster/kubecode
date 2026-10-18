import type { TranslationKey, Translator } from '@/lib/i18n'

import { ApiError } from '../api'
import type {
  WorkBoardFilter,
  WorkCard,
  WorkCommand,
  WorkCondition,
  WorkLifecycle,
  WorkStage,
} from '../api'

export const WORK_STAGES: WorkStage[] = [
  'planned', 'ready', 'executing', 'analyzing', 'review', 'done',
]

export const STAGE_LABELS: Record<WorkStage, TranslationKey> = {
  planned: 'kubecode.work.stage.planned',
  ready: 'kubecode.work.stage.ready',
  executing: 'kubecode.work.stage.executing',
  analyzing: 'kubecode.work.stage.analyzing',
  review: 'kubecode.work.stage.review',
  done: 'kubecode.work.stage.done',
}

/** Conditions that need a person's eye, in the order the attention strip lists them. */
export const ATTENTION_CONDITIONS: Exclude<WorkCondition, 'none'>[] = [
  'needs_input', 'blocked', 'waiting', 'paused',
]

export const CONDITION_LABELS: Record<Exclude<WorkCondition, 'none'>, TranslationKey> = {
  needs_input: 'kubecode.work.condition.needsInput',
  blocked: 'kubecode.work.condition.blocked',
  waiting: 'kubecode.work.condition.waiting',
  paused: 'kubecode.work.condition.paused',
}

export const LIFECYCLE_LABELS: Record<Exclude<WorkLifecycle, 'active'>, TranslationKey> = {
  canceled: 'kubecode.work.lifecycle.canceled',
  abandoned: 'kubecode.work.lifecycle.abandoned',
  superseded: 'kubecode.work.lifecycle.superseded',
}

export function filterIsEmpty(filter: WorkBoardFilter): boolean {
  return Object.values(filter).every((value) => value === undefined || value === false)
}

/** What dropping a card on a column asks for. Nothing here completes work by itself. */
export type MoveRequest =
  | { type: 'run'; command: WorkCommand }
  | { type: 'open'; form: 'assign' | 'accept' | 'reject' | 'close' }
  | { type: 'unsupported' }

export function moveRequest(card: WorkCard, to: WorkStage | 'closed', requestKey: string): MoveRequest {
  if (card.operable !== 'native' || card.item.lifecycle !== 'active') return { type: 'unsupported' }
  const from = card.item.stage
  if (to === 'closed') return { type: 'open', form: 'close' }
  if (from === to) return { type: 'unsupported' }
  if (to === 'executing') {
    if (from === 'review') return { type: 'open', form: 'reject' }
    if (from === 'ready') {
      return card.assignment
        ? { type: 'run', command: { command: 'start', request_key: requestKey } }
        : { type: 'open', form: 'assign' }
    }
  }
  if (to === 'done' && from === 'review') return { type: 'open', form: 'accept' }
  return { type: 'unsupported' }
}

/** Whether a card has an attempt that has not ended. */
export function hasOpenAttempt(card: WorkCard): boolean {
  const status = card.latest_attempt?.status
  return status === 'queued' || status === 'running' || status === 'needs_report'
    || status === 'result_submitted'
}

/** The words for a failed command; conflicts say what to do next. */
export function workErrorMessage(cause: unknown, t: Translator): string {
  if (cause instanceof ApiError) {
    switch (cause.code) {
      case 'work_state_conflict':
      case 'work_revision_conflict': return t('kubecode.work.error.stale')
      case 'work_legacy_owned': return t('kubecode.work.error.legacy')
      case 'work_budget_exhausted': return t('kubecode.work.error.budget')
      case 'work_round_paused': return t('kubecode.work.error.roundPaused')
      case 'work_not_assigned': return t('kubecode.work.error.notAssigned')
      case 'work_condition_in_use': return t('kubecode.work.error.conditionInUse')
      default: return cause.message || t('kubecode.error')
    }
  }
  return cause instanceof Error ? cause.message : t('kubecode.error')
}

export function isStale(cause: unknown): boolean {
  return cause instanceof ApiError
    && (cause.code === 'work_state_conflict' || cause.code === 'work_revision_conflict')
}

/**
 * One request key per start of a card until it succeeds, so a retry after a
 * lost response starts nothing twice. The key is tied to how many attempts the
 * card has had: once an attempt ran, the next start is a new request.
 */
export class StartKeys {
  private readonly keys = new Map<string, string>()

  private readonly create: () => string

  constructor(create: () => string) {
    this.create = create
  }

  keyFor(card: Pick<WorkCard, 'item' | 'attempt_count'>): string {
    const slot = `${card.item.id}:${card.attempt_count}`
    let key = this.keys.get(slot)
    if (!key) {
      key = this.create()
      this.keys.set(slot, key)
    }
    return key
  }

  done(card: Pick<WorkCard, 'item' | 'attempt_count'>) {
    this.keys.delete(`${card.item.id}:${card.attempt_count}`)
  }
}
