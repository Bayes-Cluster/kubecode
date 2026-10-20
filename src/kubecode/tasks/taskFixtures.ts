/**
 * Test support: Task read-model records with every field, so a test names
 * only what it is about. Not used by the app.
 */

import type { ProjectContextDocument, TaskBoard, TaskCard, TaskDetail, TaskEvidence, TaskReviewRequest } from '../api'

export function taskCard(overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    id: 'r1',
    project_id: 'p1',
    title: 'Pruning heads',
    question: 'Does pruning heads keep accuracy?',
    stage: 'ready',
    condition: 'none',
    condition_reason: null,
    outcome: null,
    revision: 1,
    approved_revision: 1,
    admitted_at: '2026-10-20 09:00:00',
    origin: 'conversation',
    authorizing_message_id: 'm1',
    participants: [
      { member_id: 'g', name: 'Gene', handle: 'general', role: 'general' },
      { member_id: 'a', name: 'Analyst', handle: 'analyst', role: 'specialist' },
    ],
    open_questions: 0,
    review_requested: false,
    updated_at: '2026-10-20 09:00:00',
    rounds: [],
    work: { total: 0, active: 0, in_review: 0, done: 0, needs_input: 0, blocked: 0 },
    last_event: null,
    ...overrides,
  }
}

export function taskBoard(cards: TaskCard[], archived: TaskBoard['archived'] = []): TaskBoard {
  return { cards, stages: [], total: cards.length, archived }
}

export function reviewRequest(overrides: Partial<TaskReviewRequest> = {}): TaskReviewRequest {
  return {
    id: 'rq1',
    research_id: 'r1',
    summary: 'Accuracy held at 0.91',
    evidence: ['file:results.csv'],
    requested_by: 's1',
    brief_revision: 1,
    state: 'open',
    created_at: '2026-10-20 10:00:00',
    resolved_at: null,
    evidence_pins: { 'file:results.csv': 'a' },
    general_message_id: 'm-req',
    ...overrides,
  }
}

export function evidenceRow(overrides: Partial<TaskEvidence> = {}): TaskEvidence {
  return {
    key: 'file:results.csv',
    kind: 'file',
    ref_id: 'results.csv',
    title: 'results.csv',
    cited_by: [
      { work_id: 'w1', result_id: 'res1', request_id: null, pinned: 'a' },
      { work_id: '', result_id: 'file:results.csv', request_id: 'rq1', pinned: 'a' },
    ],
    current: 'a',
    status: 'current',
    in_review: true,
    accepted: false,
    ...overrides,
  }
}

export function taskDetail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    ...taskCard({ stage: 'review', review_requested: true }),
    brief: {
      title: 'Pruning heads',
      question: 'Does pruning heads keep accuracy?',
      motivation: '',
      hypotheses: ['Late heads are redundant'],
      constraints: ['single GPU'],
      evaluation_criteria: ['accuracy within one point'],
    },
    revisions: [],
    authorizations: [],
    authorizing_message: { id: 'm1', body: 'That looks right. Please add it.', created_at: '2026-10-20 09:00:00', task_id: 'r1' },
    review_requests: [reviewRequest()],
    reviews: [],
    internal_work: [],
    open_questions: [],
    stale_evidence: [],
    archived: false,
    evidence: [evidenceRow()],
    timeline: [],
    pending: [{ key: 'review:rq1', kind: 'review', ref_id: 'rq1', since: '2026-10-20 10:00:00' }],
    actions: { archive: { allowed: false, reason: 'under_review' }, restore: false },
    ...overrides,
  } as TaskDetail
}

/** A Project file as the context reader returns it (ADR 0231 §1): one page, at `revision`. */
export function fileDocument(path: string, text: string, revision: string): ProjectContextDocument {
  return {
    ref: { kind: 'file', id: path, revision },
    detail: 'content',
    title: path,
    availability: 'available',
    provenance: { author: null, updated_at: null, research_id: null, parent: null, state: null },
    sections: [{ heading: 'Content', text, truncated: false }],
    related: [],
    next_cursor: null,
    notes: [],
    shown_revision: revision,
  }
}
