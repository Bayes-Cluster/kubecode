import { describe, expect, it } from 'vitest'

import {
  conditionTone,
  defaultTabOf,
  initialBoardStage,
  inspectedStage,
  nextStepOf,
  progressOf,
  requiredActionOf,
} from './taskLifecycle'
import { reviewRequest, taskBoard, taskCard, taskDetail } from './taskFixtures'

describe('nextStepOf', () => {
  const working = taskDetail({ stage: 'in_progress', review_requested: false, review_requests: [] })

  it.each([
    ['archived', taskDetail({ archived: true, revision: 3, approved_revision: 2 }), false],
    ['draft', null, true],
    ['approval', taskDetail({ revision: 3, approved_revision: 2 }), false],
    ['review', taskDetail(), false],
    ['questions', { ...working, open_questions: [{ id: 'q' }] as never }, false],
    ['returned', { ...working, last_event: { seq: 4, kind: 'review_returned', ref_id: 'v', created_at: '' } }, false],
    ['working', working, false],
    ['ready', taskDetail({ stage: 'ready', review_requests: [] }), false],
    ['done', taskDetail({ stage: 'done', review_requests: [reviewRequest({ state: 'accepted' })] }), false],
  ] as const)('says %s first when that is what waits', (kind, detail, draft) => {
    expect(nextStepOf(detail, draft).kind).toBe(kind)
  })

  it('gives each step a tone that is never the only signal', () => {
    expect(nextStepOf(taskDetail({ archived: true }), false).tone).toBe('muted')
    expect(nextStepOf(taskDetail(), false).tone).toBe('info')
    expect(nextStepOf(taskDetail({ revision: 2, approved_revision: 1 }), false).tone).toBe('warn')
    expect(nextStepOf(taskDetail({ stage: 'done', review_requests: [] }), false).tone).toBe('ok')
  })

  it('treats a Task that is neither loaded nor a draft as a draft', () => {
    expect(nextStepOf(null, false).kind).toBe('draft')
  })
})

describe('requiredActionOf', () => {
  it('asks for a review before an answer, and for nothing otherwise', () => {
    expect(requiredActionOf(taskCard({ stage: 'review', review_requested: true, open_questions: 2 }))).toBe('review')
    expect(requiredActionOf(taskCard({ stage: 'in_progress', open_questions: 1 }))).toBe('answer')
    expect(requiredActionOf(taskCard({ stage: 'review', review_requested: false }))).toBeNull()
    expect(requiredActionOf(taskCard({ stage: 'in_progress', condition: 'blocked' }))).toBeNull()
  })
})

describe('conditionTone', () => {
  it('warns on a question, alarms on a block, and stays quiet on a pause or a wait', () => {
    expect(conditionTone('needs_input')).toBe('warn')
    expect(conditionTone('blocked')).toBe('danger')
    expect(conditionTone('paused')).toBe('muted')
    expect(conditionTone('waiting')).toBe('muted')
    expect(conditionTone('none')).toBe('muted')
  })
})

describe('defaultTabOf', () => {
  it('opens on the results while a review is open, else on the overview', () => {
    expect(defaultTabOf(taskDetail())).toBe('results')
    expect(defaultTabOf(taskDetail({ review_requests: [reviewRequest({ state: 'returned' })] }))).toBe('overview')
    expect(defaultTabOf(null)).toBe('overview')
  })
})

describe('progressOf', () => {
  it('counts done work of all work, and nothing when there is none', () => {
    expect(progressOf({ total: 3, active: 1, in_review: 0, done: 2, needs_input: 0, blocked: 0 })).toEqual({ done: 2, total: 3 })
    expect(progressOf({ total: 0, active: 0, in_review: 0, done: 0, needs_input: 0, blocked: 0 })).toBeNull()
    expect(progressOf(undefined)).toBeNull()
  })
})

describe('board stages', () => {
  it('starts on the stage that needs the researcher most', () => {
    expect(initialBoardStage(taskBoard([taskCard({ stage: 'done' }), taskCard({ id: 'r2', stage: 'review' })]))).toBe('review')
    expect(initialBoardStage(taskBoard([taskCard({ stage: 'done' }), taskCard({ id: 'r2', stage: 'in_progress' })]))).toBe('in_progress')
    expect(initialBoardStage(taskBoard([taskCard({ stage: 'done' })]))).toBe('done')
    expect(initialBoardStage(taskBoard([taskCard({ stage: 'ready' }), taskCard({ id: 'r2', stage: 'done' })]))).toBe('ready')
    expect(initialBoardStage(taskBoard([]))).toBe('ready')
  })

  it('finds the stage of the Task being inspected', () => {
    const board = taskBoard([taskCard({ id: 'r1', stage: 'review' })])
    expect(inspectedStage(board, 'r1')).toBe('review')
    expect(inspectedStage(board, 'r9')).toBeNull()
    expect(inspectedStage(board, null)).toBeNull()
    expect(inspectedStage(null, 'r1')).toBeNull()
  })
})
