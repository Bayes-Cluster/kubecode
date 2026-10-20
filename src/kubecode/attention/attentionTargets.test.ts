import { describe, expect, it } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import {
  briefItem,
  inputItem,
  permissionItem,
  proposalItem,
  questionItem,
  reviewItem,
  setupItem,
  snapshot,
  suggestionItem,
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
        suggestionItem(),
        briefItem(),
        briefItem({ research_id: 'r3', key: 'brief:r3:5', revision: 5, message_id: 'msg5', task: { id: 'r3', title: 'Shown' } }),
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
      // The Task panel's own keys: the suggestion in its Results, the unshown revision in its Overview.
      ['suggestion:e7', { place: { view: 'board' }, inspect: { kind: 'task', id: 'r1' }, focus: 'suggestion:e7' }],
      ['brief:r1:3', { place: { view: 'board' }, inspect: { kind: 'task', id: 'r1' }, focus: 'brief:r1:3' }],
      ['brief:r3:5', { place: { view: 'general', message: 'msg5' }, focus: 'message:msg5' }],
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
        suggestionItem(),
        briefItem(),
        briefItem({ research_id: 'r2', key: 'brief:r2:2', revision: 2, approved_revision: 1, message_id: 'msg2', task: { id: 'r2', title: 'Quantize first' } }),
        proposalItem(),
        setupItem(),
      ],
    }), new Set(), t, { presentation: 'screen' })
    expect(entries.map((entry) => [entry.title, entry.reason.label, entry.detail, entry.group])).toEqual([
      // A permission request waits until answered: no deadline is shown.
      ['Analyst wants to use Run pytest -q', 'Permission', 'For Structured pruning', 'decision'],
      ['Analyst asks: Which split?', 'Input requested', 'times out in 2 min', 'decision'],
      ['Which ratios?', 'Question', 'In Structured pruning · asked by @analyst', 'decision'],
      ['Review the results of Structured pruning', 'Review', 'Requested by @general', 'decision'],
      ['Relax the single-GPU constraint', 'Suggestion', 'In Structured pruning', 'decision'],
      ['Structured pruning', 'Revised brief', 'Revision 3 waits for your approval', 'decision'],
      ['Quantize first', 'Revised brief', 'Revision 2 · answer in General', 'decision'],
      ['Quantize first', 'Proposal', 'Revision 1 · answer in General', 'decision'],
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
