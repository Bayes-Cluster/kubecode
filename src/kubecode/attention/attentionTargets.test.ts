import { describe, expect, it } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import {
  inputItem,
  permissionItem,
  proposalItem,
  questionItem,
  reviewItem,
  setupItem,
  snapshot,
} from './attentionFixtures'
import { needsYouFromAttention } from './attentionTargets'

const t = createTranslator('en')

describe('Needs you from the server projection (ADR 0232)', () => {
  it('opens each decision where it is made, with the key that receives focus', () => {
    const entries = needsYouFromAttention(snapshot({
      items: [
        permissionItem(),
        inputItem(),
        permissionItem({ request_id: 'q2', member: null, binding: null, conversation_id: 's9', session_title: 'Fix build', task: null }),
        questionItem(),
        reviewItem(),
        proposalItem(),
        setupItem(),
      ],
    }), new Set(), t, { presentation: 'screen' })
    expect(entries.map((entry) => [entry.key, entry.target])).toEqual([
      ['permission:q1', { place: { view: 'general' }, focus: 'permission:q1' }],
      ['input:e1', { place: { view: 'dm', member: 'm1' }, focus: 'input:e1' }],
      ['permission:q2', { session: { projectId: 'p1', conversationId: 's9' }, focus: 'permission:q2' }],
      ['question:d1', { place: { view: 'board' }, inspect: { kind: 'task', id: 'r1' }, focus: 'question:d1' }],
      ['review:v1', { place: { view: 'board' }, inspect: { kind: 'task', id: 'r1' }, focus: 'review:v1' }],
      ['proposal:r2:1', { place: { view: 'general', message: 'msg1' }, focus: 'message:msg1' }],
      ['setup:m2', { place: { view: 'members' }, inspect: { kind: 'member', id: 'm2' }, focus: 'member-setup:m2' }],
    ])
  })

  it('opens the Task beside General only when there is room for it', () => {
    const [permission, proposal] = needsYouFromAttention(
      snapshot({ items: [permissionItem(), proposalItem()] }),
      new Set(),
      t,
      { presentation: 'side' },
    )
    expect(permission.target.inspect).toEqual({ kind: 'task', id: 'r1' })
    expect(proposal.target.inspect).toEqual({ kind: 'task', id: 'r2' })
  })

  it('says what each decision is, for which Task, and how long it waits', () => {
    const entries = needsYouFromAttention(snapshot({
      items: [
        permissionItem(),
        inputItem(),
        questionItem(),
        reviewItem(),
        proposalItem({ admitted: true, revision: 2, key: 'proposal:r2:2' }),
        setupItem(),
      ],
    }), new Set(), t, { presentation: 'screen' })
    expect(entries.map((entry) => [entry.title, entry.reason.label, entry.detail, entry.group])).toEqual([
      ['Analyst wants to use Run pytest -q', 'Permission', 'For Structured pruning · times out in 4 min', 'decision'],
      ['Analyst asks: Which split?', 'Input requested', 'times out in 2 min', 'decision'],
      ['Which ratios?', 'Question', 'In Structured pruning · asked by @analyst', 'decision'],
      ['Review the results of Structured pruning', 'Review', 'Requested by @general', 'decision'],
      ['Quantize first', 'Revision proposed', 'Revision 2 · answer in General', 'decision'],
      ['Writer needs setup', 'Needs setup', 'Its provider is not available on this server', 'setup'],
    ])
  })

  it('clips a long tool title and a long question so a row stays readable', () => {
    const [permission, question] = needsYouFromAttention(snapshot({
      items: [permissionItem({ tool: 'x'.repeat(200) }), questionItem({ question: 'y'.repeat(300) })],
    }), new Set(), t, { presentation: 'screen' })
    expect(permission.title.length).toBeLessThan(90)
    expect(question.title.length).toBeLessThanOrEqual(121)
  })

  it('marks an answered decision as resolving until a newer snapshot drops it', () => {
    const [entry] = needsYouFromAttention(snapshot({ items: [questionItem()] }), new Set(['question:d1']), t, { presentation: 'screen' })
    expect(entry.state).toBe('resolving')
  })

  it('is empty without a snapshot', () => {
    expect(needsYouFromAttention(null, new Set(), t, { presentation: 'screen' })).toEqual([])
  })
})
