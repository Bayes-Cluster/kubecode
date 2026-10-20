import { describe, expect, it } from 'vitest'

import type { Translator } from '@/lib/i18n'

import type { Conversation, TaskCard, TaskDraft } from '../../api'
import { needsYouFromCurrentSources } from './needsYou'

const t = ((key: string) => key) as Translator

const card = (overrides: Partial<TaskCard>): TaskCard => ({
  id: 'r1', project_id: 'p1', title: 'Pruning', question: '?', stage: 'review', condition: 'none',
  condition_reason: null, revision: 1, approved_revision: 1, admitted_at: '', origin: 'conversation',
  authorizing_message_id: null, participants: [], open_questions: 0, review_requested: true,
  updated_at: '', ...overrides,
})

const draft: TaskDraft = {
  id: 'd1', project_id: 'p1', title: 'Quantize first', question: '?', revision: 2, proposed_by: 'agent', updated_at: '',
}

const session = (overrides: Partial<Conversation>): Conversation => (
  { id: 's9', project_id: 'p1', title: 'Fix build', ...overrides } as Conversation
)

describe('what waits for the researcher, from today’s sources', () => {
  it('keeps today’s targets: the board for Tasks, General for proposals, the Session for permissions', () => {
    const entries = needsYouFromCurrentSources(
      [
        card({}),
        card({ id: 'r2', title: 'Quant', stage: 'in_progress', condition: 'needs_input' }),
        card({ id: 'r3', title: 'Quiet', stage: 'in_progress', condition: 'none' }),
        card({ id: 'r4', title: 'Both', stage: 'review', condition: 'needs_input' }),
      ],
      [draft],
      [session({}), session({ id: 's10', project_id: 'p2', title: '' })],
      t,
    )
    expect(entries).toEqual([
      {
        key: 'review:r1',
        title: 'Pruning',
        reason: { label: 'kubecode.nav.needsReview', tone: 'warn' },
        target: { place: { view: 'board' }, inspect: { kind: 'task', id: 'r1' } },
      },
      {
        key: 'input:r2',
        title: 'Quant',
        reason: { label: 'kubecode.nav.needsInput', tone: 'warn' },
        target: { place: { view: 'board' }, inspect: { kind: 'task', id: 'r2' } },
      },
      {
        key: 'review:r4',
        title: 'Both',
        reason: { label: 'kubecode.nav.needsReview', tone: 'warn' },
        target: { place: { view: 'board' }, inspect: { kind: 'task', id: 'r4' } },
      },
      {
        key: 'proposal:d1',
        title: 'Quantize first',
        reason: { label: 'kubecode.nav.needsProposal', tone: 'info' },
        target: { place: { view: 'general' }, inspect: { kind: 'task', id: 'd1' } },
      },
      {
        key: 'permission:s9',
        title: 'Fix build',
        reason: { label: 'kubecode.nav.needsPermission', tone: 'warn' },
        target: { session: { projectId: 'p1', conversationId: 's9' } },
      },
      {
        key: 'permission:s10',
        title: 'kubecode.untitledSession',
        reason: { label: 'kubecode.nav.needsPermission', tone: 'warn' },
        target: { session: { projectId: 'p2', conversationId: 's10' } },
      },
    ])
  })

  it('is empty when nothing waits', () => {
    expect(needsYouFromCurrentSources([card({ stage: 'done' })], [], [], t)).toEqual([])
  })
})
