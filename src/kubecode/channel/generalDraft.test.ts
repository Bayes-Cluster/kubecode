import { describe, expect, it } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import type { ProjectContextItem } from '../api'
import { memberDirectory } from '../members/memberDirectory'
import { analyst, channelMessage, general, member, writer } from '../members/memberFixtures'
import { authorView } from '../members/memberIdentity'
import {
  draftRecipients,
  emptyGeneralDraft,
  mentionTokens,
  removeMention,
  sendBlockedReason,
  toNewMessage,
  withReply,
  type GeneralDraft,
} from './generalDraft'

const t = createTranslator('en')
const unready = member({ id: 'u', name: 'Unready', handle: 'unready', state: 'setup_required', public_conversation_id: null })
const removed = member({ id: 'old', name: 'Old', handle: 'old', state: 'removed', public_conversation_id: null })
const directory = memberDirectory({ members: [general, analyst, writer, unready, removed], general_id: 'g' }, 'ready')

const fromAgent = (memberId: string | null, extra = {}) => channelMessage(4, {
  author_kind: 'agent', author_ref: 's-x', author_member_id: memberId, body: 'Ran the sweep; accuracy held.', ...extra,
})
const reply = (draft: GeneralDraft, message = fromAgent('a')) => withReply(draft, message, authorView(message, directory, [], t), directory)
const picked = (kind: ProjectContextItem['ref']['kind'], id: string): ProjectContextItem => ({
  ref: { kind, id, revision: 'v1' }, title: id, summary: '',
  provenance: { author: null, updated_at: null, research_id: null, parent: null, state: null },
  availability: 'available',
} as ProjectContextItem)

describe('emptyGeneralDraft', () => {
  it('is about the Task General is showing', () => {
    expect(emptyGeneralDraft(null)).toEqual({ body: '', reply: null, task: null, taskCleared: false, references: [], attempt: null })
    expect(emptyGeneralDraft('r1').task).toBe('r1')
  })
})

describe('withReply', () => {
  it('cites the message and names a specialist who can receive once, with their current handle', () => {
    const once = reply(emptyGeneralDraft(null))
    expect(once.reply).toEqual({ messageId: 'm4', authorName: 'Analyst', excerpt: 'Ran the sweep; accuracy held.' })
    expect(once.body).toBe('@analyst ')
    expect(reply({ ...once, body: '@analyst sure' }).body).toBe('@analyst sure')
    expect(reply({ ...emptyGeneralDraft(null), body: 'thanks' }).body).toBe('@analyst thanks')
  })

  it('adds no @general for the manager, unless the draft already names someone else', () => {
    expect(reply(emptyGeneralDraft(null), fromAgent('g')).body).toBe('')
    expect(reply({ ...emptyGeneralDraft(null), body: '@writer and you' }, fromAgent('g')).body).toBe('@general @writer and you')
  })

  it('names no one for the researcher, Kubecode, a removed member, a member who cannot receive, or a non-member', () => {
    const empty = emptyGeneralDraft(null)
    expect(reply(empty, channelMessage(2)).body).toBe('')
    expect(reply(empty, channelMessage(3, { author_kind: 'system', kind: 'system' })).body).toBe('')
    expect(reply(empty, fromAgent('old')).body).toBe('')
    expect(reply(empty, fromAgent('u')).body).toBe('')
    expect(reply(empty, fromAgent(null)).body).toBe('')
  })

  it('takes the cited message’s Task unless the researcher removed the draft’s Task', () => {
    const about = fromAgent('a', { task_id: 'r9' })
    expect(reply(emptyGeneralDraft(null), about).task).toBe('r9')
    expect(reply(emptyGeneralDraft('r1'), about).task).toBe('r1')
    expect(reply({ ...emptyGeneralDraft(null), taskCleared: true }, about).task).toBeNull()
  })

  it('replaces an earlier reply target, and shortens a long excerpt', () => {
    const long = channelMessage(5, { body: 'x'.repeat(200) })
    const twice = reply(reply(emptyGeneralDraft(null)), long)
    expect(twice.reply?.messageId).toBe('m5')
    expect(twice.reply?.excerpt).toHaveLength(81)
  })
})

describe('draftRecipients', () => {
  it('goes to the manager when the draft names no one', () => {
    expect(draftRecipients('what next?', directory)).toEqual({ kind: 'manager', manager: general })
  })

  it('names whole-token handles of live members, in order, and ignores quotes and code', () => {
    const body = '@writer then @analyst\n> @unready said\n```\n@general\n```\nuse `@general` or @ana'
    expect(draftRecipients(body, directory)).toEqual({ kind: 'members', reachable: [writer, analyst], unreachable: [] })
    expect(mentionTokens(body)).toEqual(['writer', 'analyst', 'ana'])
  })

  it('classifies a member who cannot receive, and ignores a removed member’s handle', () => {
    expect(draftRecipients('@unready @Analyst @old', directory)).toEqual({
      kind: 'members', reachable: [analyst], unreachable: [{ member: unready, reason: 'needs_setup' }],
    })
  })
})

describe('removeMention', () => {
  it('strips the whole token and one following space, not a longer handle or a quoted one', () => {
    expect(removeMention('@analyst please check', 'analyst')).toBe('please check')
    expect(removeMention('ask @analyst now', 'analyst')).toBe('ask now')
    expect(removeMention('@analysts and @analyst', 'analyst')).toBe('@analysts and ')
    expect(removeMention('> @analyst said\n@analyst ok', 'analyst')).toBe('> @analyst said\nok')
  })
})

describe('sendBlockedReason', () => {
  it('blocks a draft naming someone who cannot receive, or too many members', () => {
    expect(sendBlockedReason(draftRecipients('@analyst', directory), t)).toBeNull()
    expect(sendBlockedReason(draftRecipients('hello', directory), t)).toBeNull()
    expect(sendBlockedReason(draftRecipients('@unready', directory), t))
      .toBe("Unready can't receive messages yet (Needs setup). Remove the mention, or fix Unready in Members.")
    const crowd = Array.from({ length: 9 }, (_, index) => member({ id: `c${index}`, name: `C${index}`, handle: `c${index}` }))
    const many = memberDirectory({ members: crowd, general_id: null }, 'ready')
    expect(sendBlockedReason(draftRecipients(crowd.map((item) => `@${item.handle}`).join(' '), many), t))
      .toBe('A message can name at most 8 members.')
  })
})

describe('toNewMessage', () => {
  const draft: GeneralDraft = {
    body: '  @analyst look at this  ',
    reply: { messageId: 'm4', authorName: 'Analyst', excerpt: '' },
    task: 'r1',
    taskCleared: false,
    references: [picked('artifact', 'a1'), picked('artifact', 'a1'), picked('research', 'r1')],
    attempt: null,
  }

  it('names members by id, puts the Task first among the references, and cites the reply', () => {
    const { message } = toNewMessage(draft, draftRecipients(draft.body, directory))
    expect(message).toEqual({
      body: '@analyst look at this',
      mentions: [{ member_id: 'a' }],
      references: [{ kind: 'research', id: 'r1', revision: null }, { kind: 'artifact', id: 'a1', revision: 'v1' }],
      replyTo: 'm4',
    })
    expect(toNewMessage({ ...draft, task: null, reply: null }, draftRecipients('hi', directory)).message)
      .toMatchObject({ mentions: [], replyTo: null })
  })

  it('has the same signature for the same draft and another when the recipients change', () => {
    const first = toNewMessage(draft, draftRecipients(draft.body, directory)).signature
    expect(toNewMessage({ ...draft }, draftRecipients(draft.body, directory)).signature).toBe(first)
    const other = { ...draft, body: '@writer look at this' }
    expect(toNewMessage(other, draftRecipients(other.body, directory)).signature).not.toBe(first)
  })
})
