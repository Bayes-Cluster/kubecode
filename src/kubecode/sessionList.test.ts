import { describe, expect, it } from 'vitest'

import { buildSessionSections, normalizeSessionListPreferences } from './sessionList'
import type { Conversation } from './api'

describe('session list model', () => {
  it('normalizes persisted filters without trusting invalid values', () => {
    expect(normalizeSessionListPreferences({
      agent: 'claude_code',
      query: '  auth ',
      showArchived: true,
      sort: 'title',
    })).toEqual({
      agent: 'claude_code',
      query: '  auth ',
      showArchived: true,
      sort: 'title',
    })
    expect(normalizeSessionListPreferences({ agent: 'other', sort: 'random' })).toMatchObject({
      agent: 'all',
      showArchived: false,
      sort: 'activity',
    })
  })

  it('prioritizes sessions requiring input and separates archived sessions', () => {
    const sections = buildSessionSections([
      session('attention', { latest_run_status: 'waiting_permission', updated_at: '2026-07-16T09:00:00Z' }),
      session('running', { latest_run_status: 'running', updated_at: '2026-07-16T08:00:00Z' }),
      session('today', { updated_at: '2026-07-16T07:00:00Z' }),
      session('archived', { archived: true, updated_at: '2026-07-15T07:00:00Z' }),
    ], {
      agent: 'all', query: '', showArchived: true, sort: 'activity',
    }, new Date('2026-07-16T12:00:00Z'))

    expect(sections.map((section) => section.id)).toEqual([
      'attention', 'running', 'today', 'archived',
    ])
    expect(sections[0]?.sessions[0]?.id).toBe('attention')
  })

  it('searches by title and filters by Agent', () => {
    const sections = buildSessionSections([
      session('one', { agent_id: 'codex', title: 'Fix auth flow' }),
      session('two', { agent_id: 'claude_code', title: 'Document auth flow' }),
    ], {
      agent: 'claude_code', query: 'AUTH', showArchived: false, sort: 'title',
    }, new Date('2026-07-16T12:00:00Z'))

    expect(sections.flatMap((section) => section.sessions).map((item) => item.id)).toEqual(['two'])
  })
})

function session(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id,
    project_id: 'project-1',
    agent_id: 'codex',
    provider_session_id: null,
    title: id,
    manual_title: null,
    agent_title: id,
    created_at: '2026-07-16T06:00:00Z',
    updated_at: '2026-07-16T06:00:00Z',
    archived: false,
    ...overrides,
  }
}
