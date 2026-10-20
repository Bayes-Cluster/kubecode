/**
 * Test support: attention snapshots and items as the server sends them
 * (ADR 0232). Not used by the app.
 */

import { vi } from 'vitest'

import type { AttentionStore, ExecutionScope } from './attentionContext'
import type {
  AttentionItem,
  AttentionMemberRef,
  AttentionSnapshot,
  ExecutionFailure,
  ExecutionView,
  MessageDelivery,
  RouteDelivery,
} from '../api'

export const analyst: AttentionMemberRef = { id: 'm1', name: 'Analyst', handle: 'analyst', role: 'specialist' }
export const manager: AttentionMemberRef = { id: 'g1', name: 'General Agent', handle: 'general', role: 'general' }
export const pruning = { id: 'r1', title: 'Structured pruning' }

const base = {
  project_id: 'p1',
  group: 'decision' as const,
  created_at: '2026-10-20 10:00:00',
  deadline_ms: null,
  task: null,
  member: null,
  binding: null,
  conversation_id: null,
  session_title: null,
}

type Kinded<K extends AttentionItem['kind']> = Extract<AttentionItem, { kind: K }>

export function permissionItem(overrides: Partial<Kinded<'permission'>> = {}): Kinded<'permission'> {
  return {
    ...base,
    key: `permission:${overrides.request_id ?? 'q1'}`,
    kind: 'permission',
    request_id: 'q1',
    run_id: 'run1',
    tool: 'Run pytest -q',
    options: [
      { id: 'allow', label: 'Allow once', kind: 'allow_once' },
      { id: 'reject', label: 'Reject', kind: 'reject_once' },
    ],
    deadline_ms: 240_000,
    task: pruning,
    member: analyst,
    binding: 'public',
    conversation_id: 's1',
    ...overrides,
  }
}

export function inputItem(overrides: Partial<Kinded<'input'>> = {}): Kinded<'input'> {
  return {
    ...base,
    key: `input:${overrides.request_id ?? 'e1'}`,
    kind: 'input',
    request_id: 'e1',
    run_id: 'run1',
    message: 'Which split?',
    schema: {
      type: 'object',
      properties: { split: { type: 'string', title: 'Split' } },
      required: ['split'],
    },
    deadline_ms: 120_000,
    member: analyst,
    binding: 'dm',
    conversation_id: 'dm1',
    ...overrides,
  }
}

export function questionItem(overrides: Partial<Kinded<'question'>> = {}): Kinded<'question'> {
  return {
    ...base,
    key: `question:${overrides.request_id ?? 'd1'}`,
    kind: 'question',
    request_id: 'd1',
    work_id: 'w1',
    work_title: 'Sweep',
    question: 'Which ratios?',
    options: [],
    impact: null,
    task: pruning,
    member: analyst,
    ...overrides,
  }
}

export function reviewItem(overrides: Partial<Kinded<'review'>> = {}): Kinded<'review'> {
  return {
    ...base,
    key: `review:${overrides.request_id ?? 'v1'}`,
    kind: 'review',
    request_id: 'v1',
    brief_revision: 1,
    task: pruning,
    member: manager,
    ...overrides,
  }
}

export function proposalItem(overrides: Partial<Kinded<'proposal'>> = {}): Kinded<'proposal'> {
  return {
    ...base,
    key: `proposal:${overrides.research_id ?? 'r2'}:${overrides.revision ?? 1}`,
    kind: 'proposal',
    research_id: 'r2',
    revision: 1,
    message_id: 'msg1',
    admitted: false,
    task: { id: 'r2', title: 'Quantize first' },
    member: manager,
    ...overrides,
  }
}

export function setupItem(overrides: Partial<Kinded<'setup'>> = {}): Kinded<'setup'> {
  return {
    ...base,
    key: `setup:${overrides.member_id ?? 'm2'}`,
    kind: 'setup',
    group: 'setup',
    member_id: 'm2',
    setup_code: 'provider_unavailable',
    member: { id: 'm2', name: 'Writer', handle: 'writer', role: 'specialist' },
    ...overrides,
  }
}

export function execution(overrides: Partial<ExecutionView> = {}): ExecutionView {
  return {
    run_id: 'run1',
    conversation_id: 's1',
    status: 'running',
    started_at: '2026-10-20 10:00:00',
    member: analyst,
    binding: 'public',
    session_title: null,
    tasks: [pruning],
    queued: 0,
    waiting_keys: [],
    ...overrides,
  }
}

export function failure(overrides: Partial<ExecutionFailure> = {}): ExecutionFailure {
  return {
    run_id: 'run0',
    conversation_id: 's1',
    member: analyst,
    binding: 'public',
    status: 'failed',
    ended_at: '2026-10-20 09:00:00',
    ...overrides,
  }
}

export function snapshot(overrides: Partial<AttentionSnapshot> = {}): AttentionSnapshot {
  return {
    project_id: 'p1',
    cursor: 1,
    items: [],
    executions: [],
    failures: [],
    undelivered: { general: 0, tasks: {} },
    incomplete: [],
    truncated: false,
    ...overrides,
  }
}

export function routeDelivery(overrides: Partial<RouteDelivery> = {}): RouteDelivery {
  return {
    route_id: 'route1',
    kind: 'mention',
    recipient: analyst,
    recipient_session: 's1',
    state: 'started',
    attempts: 1,
    busy: 0,
    retries: 0,
    last_error: null,
    delivered_at: '2026-10-20 10:00:01',
    retryable: false,
    note_ids: [],
    ...overrides,
  }
}

export function messageDelivery(overrides: Partial<MessageDelivery> = {}): MessageDelivery {
  return {
    message_id: 'msg1',
    state: 'delivered',
    routes: [routeDelivery()],
    denial: null,
    ...overrides,
  }
}

function inScope(scope: ExecutionScope, entry: { binding: string | null; member: { id: string } | null; tasks?: { id: string }[] }) {
  if ('taskId' in scope) return entry.tasks?.some((task) => task.id === scope.taskId) ?? false
  if (scope.binding === 'public') return entry.binding === 'public'
  return entry.binding === 'dm' && entry.member?.id === scope.memberId
}

/** An attention store over a fixed snapshot; `markResolving` runs the call. */
export function attentionStore(value: AttentionSnapshot = snapshot(), overrides: Partial<AttentionStore> = {}): AttentionStore {
  return {
    projectId: value.project_id,
    snapshot: value,
    status: 'ready',
    forTask: (taskId) => value.items.filter((item) => item.task?.id === taskId),
    byKey: (key) => value.items.find((item) => item.key === key),
    executions: (scope) => value.executions.filter((run) => inScope(scope, run)),
    failures: (scope) => value.failures.filter((run) => inScope(scope, run)),
    resolving: new Set(),
    markResolving: vi.fn((_key: string, call: () => Promise<unknown>) => call()) as AttentionStore['markResolving'],
    reload: vi.fn(),
    ...overrides,
  }
}
