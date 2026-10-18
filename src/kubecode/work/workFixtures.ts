import type { KubecodeApi, WorkBoard, WorkCard, WorkDetail, WorkItem } from '../api'

export function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'w1', project_id: 'p1', research_id: 'r1', round_id: 'round-1', team_id: null,
    origin: 'native', kind: 'other', title: 'Sweep ratios', description: 'Try 10%, 30%, 50%',
    plan: null, result: null, verification: null, stage: 'ready', condition: 'none',
    condition_reason: null, review_kind: null, lifecycle: 'active', closed_reason: null,
    superseded_by: null, acceptance: 'pending', outcome: 'unknown', priority: 0, revision: 1,
    state_revision: 3, derived_from: null, dependencies: [], created_by: null,
    created_at: '2026-10-18 10:00:00', updated_at: '2026-10-18 10:00:00',
    ...overrides,
  }
}

export function workCard(overrides: Partial<WorkItem> = {}, extra: Partial<WorkCard> = {}): WorkCard {
  return {
    item: workItem(overrides),
    assignment: null,
    latest_attempt: null,
    attempt_count: 0,
    results: [],
    dependency_states: [],
    supersedes: [],
    experiment_count: 0,
    last_activity_at: '2026-10-18 10:00:00',
    research: { id: 'r1', title: 'Pruning' },
    round: { id: 'round-1', number: 1 },
    team: null,
    executor: null,
    origin_thread: null,
    blockers: [],
    operable: 'native',
    delivery: null,
    ...extra,
  }
}

export function boardOf(cards: WorkCard[], closed: WorkCard[] = []): WorkBoard {
  const stages = (['planned', 'ready', 'executing', 'analyzing', 'review', 'done'] as const)
    .map((stage) => ({ stage, count: cards.filter((card) => card.item.stage === stage).length }))
  const conditions = (['needs_input', 'waiting', 'blocked', 'paused'] as const).map((condition) => ({
    condition,
    count: cards.filter((card) => card.item.condition === condition).length,
  }))
  return {
    cards, stages, conditions, total: cards.length, truncated: false, closed, closed_truncated: false,
  }
}

export function detailOf(card: WorkCard, extra: Partial<WorkDetail> = {}): WorkDetail {
  return {
    ...card,
    attempts: [],
    assignments: [],
    reviews: [],
    routes: [],
    experiments: [],
    ...extra,
  }
}

export function workApi(overrides: Partial<Record<keyof KubecodeApi, unknown>> = {}) {
  return overrides as unknown as KubecodeApi
}
