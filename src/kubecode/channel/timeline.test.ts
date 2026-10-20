import { describe, expect, it } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import { channelMessage } from '../members/memberFixtures'
import { notesDelivery } from './delivery'
import { buildTimeline, deliveryNoteSource, displayReferences, type TimelineItem } from './timeline'

const t = createTranslator('en')
const now = new Date('2026-10-20T12:00:00Z')
const at = (seq: number, created: string, extra = {}) => channelMessage(seq, { created_at: created, ...extra })
const note = (seq: number, created: string, extra = {}) => at(seq, created, { kind: 'system', author_kind: 'system', ...extra })
const shape = (items: TimelineItem[]) => items.map((item) => {
  if (item.kind === 'date') return `date:${item.label}`
  if (item.kind === 'activity') return `activity:${item.messages.map((message) => message.id).join(',')}`
  return `${item.message.id}${item.continued ? '+' : ''}${item.notes.length ? `[${item.notes.map((n) => n.id).join(',')}]` : ''}`
})

describe('buildTimeline', () => {
  it('separates days as Today, Yesterday, or the date in the reader’s language', () => {
    const items = buildTimeline([
      at(1, '2026-10-01 12:00:00'),
      at(2, '2026-10-19 12:00:00'),
      at(3, '2026-10-20 12:00:00'),
    ], { locale: 'en-US', now, t })
    expect(shape(items)).toEqual(['date:October 1, 2026', 'm1', 'date:Yesterday', 'm2', 'date:Today', 'm3'])
    const german = buildTimeline([at(1, '2026-10-01 12:00:00')], { locale: 'de-DE', now, t })
    expect(german[0]).toMatchObject({ kind: 'date', label: '1. Oktober 2026' })
  })

  it('groups one author’s messages within five minutes, and breaks on time, a reply, or other recipients', () => {
    const agent = { author_kind: 'agent', author_ref: 's-a', author_member_id: 'a' }
    const items = buildTimeline([
      at(1, '2026-10-20 12:00:00', agent),
      at(2, '2026-10-20 12:04:00', { ...agent, author_ref: 's-a2' }),
      at(3, '2026-10-20 12:20:00', agent),
      at(4, '2026-10-20 12:21:00', { ...agent, reply_to: 'm1' }),
      at(5, '2026-10-20 12:22:00', { ...agent, mentions: [{ session_id: 's-w' }] }),
      at(6, '2026-10-20 12:23:00'),
      at(7, '2026-10-20 12:23:30'),
    ], { locale: 'en-US', now, t })
    expect(shape(items)).toEqual(['date:Today', 'm1', 'm2+', 'm3', 'm4', 'm5', 'm6', 'm7+'])
  })

  it('collapses runs of routine notes, keeps a note about a Task as a message, and breaks a group around them', () => {
    const items = buildTimeline([
      at(1, '2026-10-20 12:00:00'),
      note(2, '2026-10-20 12:00:10', { body: 'routed' }),
      note(3, '2026-10-20 12:00:20', { body: 'routed again' }),
      at(4, '2026-10-20 12:01:00'),
      note(5, '2026-10-20 12:02:00', { task_id: 'r1', body: 'Review accepted' }),
      note(6, '2026-10-20 12:03:00'),
    ], { locale: 'en-US', now, t })
    expect(shape(items)).toEqual(['date:Today', 'm1', 'activity:m2,m3', 'm4', 'm5', 'activity:m6'])
  })

  it('shows a denial note on the message it is about, or in activity when that message is not loaded', () => {
    const items = buildTimeline([
      at(1, '2026-10-20 12:00:00'),
      note(2, '2026-10-20 12:00:10', { client_message_id: 'route-denied:m1', body: 'Your message was not delivered: x.' }),
      note(3, '2026-10-20 12:00:20', { client_message_id: 'handoff-denied:m0', body: 'A hand-off was not delivered.' }),
    ], { locale: 'en-US', now, t })
    expect(shape(items)).toEqual(['date:Today', 'm1[m2]', 'activity:m3'])
    const first = items[1]
    expect(first.kind === 'message' && notesDelivery(first.message, first.notes)).toEqual({
      state: 'failed', text: 'Your message was not delivered: x.',
    })
  })
})

describe('deliveryNoteSource and notesDelivery', () => {
  it('reads the message a denial note is about, and never claims a delivery', () => {
    expect(deliveryNoteSource(note(1, '', { client_message_id: 'route-denied:m9' }))).toBe('m9')
    expect(deliveryNoteSource(note(1, '', { client_message_id: 'handoff-denied:m8' }))).toBe('m8')
    expect(deliveryNoteSource(note(1, '', { client_message_id: 'route-failed:route1' }))).toBeNull()
    expect(deliveryNoteSource(at(1, '', { client_message_id: 'route-denied:m9' }))).toBeNull()
    expect(notesDelivery(at(1, ''), [])).toBeNull()
  })
})

describe('displayReferences', () => {
  it('drops the reference that only repeats the Task, and duplicates', () => {
    const message = at(1, '', {
      task_id: 'r1',
      references: [
        { kind: 'research', id: 'r1', revision: null },
        { kind: 'artifact', id: 'a1', revision: 'v1' },
        { kind: 'artifact', id: 'a1', revision: 'v2' },
        { kind: 'research', id: 'r2', revision: null },
      ],
    })
    expect(displayReferences(message)).toEqual([
      { kind: 'artifact', id: 'a1', revision: 'v1' },
      { kind: 'research', id: 'r2', revision: null },
    ])
  })
})
