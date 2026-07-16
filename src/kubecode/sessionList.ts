import type { AgentId, Conversation } from './api'

export const SESSION_LIST_STORAGE_KEY = 'kubecode:session-list:v1'

export type SessionAgentFilter = 'all' | AgentId
export type SessionSort = 'activity' | 'created' | 'title'
export type SessionSectionId = 'attention' | 'running' | 'today' | 'week' | 'older' | 'archived'

export type SessionListPreferences = {
  agent: SessionAgentFilter
  query: string
  showArchived: boolean
  sort: SessionSort
}

export type SessionSection = {
  id: SessionSectionId
  sessions: Conversation[]
}

export const DEFAULT_SESSION_LIST_PREFERENCES: SessionListPreferences = {
  agent: 'all',
  query: '',
  showArchived: false,
  sort: 'activity',
}

type SessionListStorage = Pick<Storage, 'getItem' | 'setItem'>

const AGENT_FILTERS = new Set<SessionAgentFilter>(['all', 'claude_code', 'codex', 'opencode'])
const SORTS = new Set<SessionSort>(['activity', 'created', 'title'])
const SECTION_ORDER: SessionSectionId[] = ['attention', 'running', 'today', 'week', 'older', 'archived']

export function normalizeSessionListPreferences(value: unknown): SessionListPreferences {
  const stored = record(value)
  return {
    agent: AGENT_FILTERS.has(stored.agent as SessionAgentFilter)
      ? stored.agent as SessionAgentFilter
      : DEFAULT_SESSION_LIST_PREFERENCES.agent,
    query: typeof stored.query === 'string' ? stored.query : DEFAULT_SESSION_LIST_PREFERENCES.query,
    showArchived: typeof stored.showArchived === 'boolean'
      ? stored.showArchived
      : DEFAULT_SESSION_LIST_PREFERENCES.showArchived,
    sort: SORTS.has(stored.sort as SessionSort)
      ? stored.sort as SessionSort
      : DEFAULT_SESSION_LIST_PREFERENCES.sort,
  }
}

export function readSessionListPreferences(storage: SessionListStorage): SessionListPreferences {
  try {
    const value = storage.getItem(SESSION_LIST_STORAGE_KEY)
    return normalizeSessionListPreferences(value ? JSON.parse(value) : null)
  } catch {
    return DEFAULT_SESSION_LIST_PREFERENCES
  }
}

export function writeSessionListPreferences(
  storage: SessionListStorage,
  preferences: SessionListPreferences,
): void {
  try {
    storage.setItem(SESSION_LIST_STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    // Browser storage can be unavailable in restricted contexts.
  }
}

export function buildSessionSections(
  conversations: Conversation[],
  preferences: SessionListPreferences,
  now = new Date(),
): SessionSection[] {
  const query = preferences.query.trim().toLocaleLowerCase()
  const visible = conversations
    .filter((conversation) => preferences.showArchived || !conversation.archived)
    .filter((conversation) => preferences.agent === 'all' || conversation.agent_id === preferences.agent)
    .filter((conversation) => !query || conversation.title.toLocaleLowerCase().includes(query))
    .sort(sessionComparator(preferences.sort))
  const grouped = new Map<SessionSectionId, Conversation[]>()
  for (const conversation of visible) {
    const section = sessionSection(conversation, now)
    grouped.set(section, [...grouped.get(section) ?? [], conversation])
  }
  return SECTION_ORDER.flatMap((id) => {
    const sessions = grouped.get(id)
    return sessions?.length ? [{ id, sessions }] : []
  })
}

function sessionSection(conversation: Conversation, now: Date): SessionSectionId {
  if (conversation.archived) return 'archived'
  if (conversation.latest_run_status === 'waiting_permission') return 'attention'
  if (conversation.latest_run_status === 'running') return 'running'
  const activity = dateValue(conversation.updated_at ?? conversation.created_at)
  const age = startOfDay(now).getTime() - startOfDay(activity).getTime()
  if (age <= 0) return 'today'
  if (age < 7 * 86_400_000) return 'week'
  return 'older'
}

function sessionComparator(sort: SessionSort): (left: Conversation, right: Conversation) => number {
  if (sort === 'title') {
    return (left, right) => left.title.localeCompare(right.title, undefined, { sensitivity: 'base' })
  }
  const field = sort === 'created' ? 'created_at' : 'updated_at'
  return (left, right) => timestamp(right[field]) - timestamp(left[field])
}

function timestamp(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : 0
  return Number.isFinite(parsed) ? parsed : 0
}

function dateValue(value: string | undefined): Date {
  const timestampValue = timestamp(value)
  return timestampValue ? new Date(timestampValue) : new Date(0)
}

function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate())
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}
