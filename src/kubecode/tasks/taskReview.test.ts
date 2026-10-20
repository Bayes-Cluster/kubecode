import { describe, expect, it } from 'vitest'

import { acceptBlocker, repinsFor, reviewEvidence, versionCheck } from './taskReview'
import { evidenceRow, taskDetail } from './taskFixtures'

describe('versionCheck', () => {
  const changed = evidenceRow({ status: 'changed', current: 'b' })

  it.each([
    ['current needs no look', evidenceRow(), undefined, { state: 'not_needed' }],
    ['unpinned needs no look', evidenceRow({ status: 'unpinned' }), undefined, { state: 'not_needed' }],
    ['removed is acknowledged instead', evidenceRow({ status: 'removed', current: null }), 'a', { state: 'removed' }],
    ['changed and never shown is unseen', changed, undefined, { state: 'unseen' }],
    ['changed and shown without a version cannot be accepted', changed, null, { state: 'unversioned' }],
    ['changed and shown at another version must be looked at again', changed, 'a', { state: 'seen_older', seen: 'a' }],
    ['changed and shown at the current version may be accepted', changed, 'b', { state: 'seen_current', seen: 'b' }],
  ] as const)('%s', (_name, row, displayed, expected) => {
    expect(versionCheck(row, displayed)).toEqual(expected)
  })
})

describe('acceptBlocker', () => {
  const changed = evidenceRow({ status: 'changed', current: 'b' })
  const removed = evidenceRow({ key: 'file:gone.csv', ref_id: 'gone.csv', status: 'removed', current: null })

  it('names the first thing that stops an acceptance, in order', () => {
    expect(acceptBlocker(taskDetail({ archived: true, evidence: [changed] }), false, 'unknown')).toBe('archived')
    expect(acceptBlocker(taskDetail({ evidence: [changed, removed] }), false, 'unknown')).toBe('changed')
    expect(acceptBlocker(taskDetail({ evidence: [removed] }), false, 'unknown')).toBe('removed_ack')
    expect(acceptBlocker(taskDetail({ evidence: [removed] }), true, 'unknown')).toBe('outcome')
    expect(acceptBlocker(taskDetail({ evidence: [removed] }), true, 'refuted')).toBeNull()
    expect(acceptBlocker(taskDetail({ evidence: undefined }), false, 'supported')).toBeNull()
  })
})

describe('reviewEvidence', () => {
  it('separates what the open review cites, what was accepted, and the rest', () => {
    const inReview = evidenceRow()
    const accepted = evidenceRow({ key: 'artifact:a1', in_review: false, accepted: true })
    const other = evidenceRow({ key: 'artifact:a2', in_review: false })
    expect(reviewEvidence(taskDetail({ evidence: [inReview, accepted, other] }))).toEqual({
      review: [inReview], accepted: [accepted], other: [other],
    })
    expect(reviewEvidence(taskDetail({ evidence: undefined }))).toEqual({ review: [], accepted: [], other: [] })
  })
})

describe('repinsFor', () => {
  it('moves every pin that is not at the current version: the work\'s and the review\'s', () => {
    const row = evidenceRow({
      status: 'changed',
      current: 'b',
      cited_by: [
        { work_id: 'w1', result_id: 'res1', request_id: null, pinned: 'a' },
        { work_id: '', result_id: 'file:results.csv', request_id: 'rq1', pinned: 'a2' },
        { work_id: 'w2', result_id: 'res2', request_id: null, pinned: 'b' },
        { work_id: 'w3', result_id: 'res3', request_id: null, pinned: null },
      ],
    })
    expect(repinsFor(row)).toEqual([
      { work_id: 'w1', result_id: 'res1', request_id: null, pinned: 'a' },
      { work_id: '', result_id: 'file:results.csv', request_id: 'rq1', pinned: 'a2' },
    ])
  })
})
