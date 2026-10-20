import { describe, expect, it } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import type { Conversation } from '../api'
import { memberDirectory } from './memberDirectory'
import { analyst, channelMessage, general, member, writer } from './memberFixtures'
import { authorView, memberView, messageRecipients, researcherView, systemView } from './memberIdentity'

const t = createTranslator('en')
const removedWriter = { ...writer, state: 'removed' as const, public_conversation_id: null, removed_at: '2026-10-19' }
const unready = member({ id: 'u', name: 'Unready', handle: 'unready', state: 'setup_required', public_conversation_id: null })
const directory = memberDirectory({ members: [general, analyst, writer, unready], general_id: 'g' }, 'ready')
const session = { id: 's-solo', title: 'Solo exploration' } as Conversation

describe('memberView', () => {
  it('names the project manager and a specialist by role in words, with no status for an active member', () => {
    expect(memberView(general, t)).toEqual({
      key: 'member:g', name: 'General', handle: 'general', role: 'manager', roleLabel: 'Project manager', memberId: 'g',
    })
    expect(memberView(analyst, t)).toEqual({
      key: 'member:a', name: 'Analyst', handle: 'analyst', role: 'specialist', roleLabel: 'Specialist · Analysis', memberId: 'a',
    })
  })

  it('shows membership only when it needs the researcher, and a removed member cannot be opened', () => {
    expect(memberView(unready, t).attention).toEqual({ label: 'Needs setup', tone: 'warn' })
    const gone = memberView(removedWriter, t)
    expect(gone.attention).toEqual({ label: 'Removed', tone: 'muted' })
    expect(gone.memberId).toBeUndefined()
    expect(gone.name).toBe('Writer')
  })

  it('names the researcher and Kubecode', () => {
    expect(researcherView(t)).toMatchObject({ key: 'researcher', name: 'You', role: 'researcher' })
    expect(systemView(t)).toMatchObject({ key: 'system', name: 'Kubecode', role: 'system' })
  })
})

describe('authorView', () => {
  const agent = (ref: string, extra = {}) => channelMessage(1, { author_kind: 'agent', author_ref: ref, ...extra })

  it('names the member through the server projection, even through an ended Session', () => {
    expect(authorView(agent('s-old-analyst', { author_member_id: 'a' }), directory, [], t).name).toBe('Analyst')
  })

  it('falls back to the current Sessions when the projection is missing, then to a Session title', () => {
    expect(authorView(agent('s-w'), directory, [], t).name).toBe('Writer')
    expect(authorView(agent('s-solo', { author_member_id: null }), directory, [session], t)).toMatchObject({
      name: 'Solo exploration', roleLabel: 'Session',
    })
  })

  it('says it does not know an agent instead of calling it "Agent" or someone else', () => {
    const unknown = authorView(agent('s-elsewhere', { author_member_id: null }), directory, [], t)
    expect(unknown).toMatchObject({ name: 'Unknown agent', roleLabel: 'Not a Workspace member' })
    expect(unknown.memberId).toBeUndefined()
    expect(authorView(agent('s-elsewhere', { author_member_id: 'nobody' }), directory, [], t).name).toBe('Unknown agent')
    expect(authorView(channelMessage(1, { author_kind: 'agent', author_ref: null }), directory, [], t).name).not.toBe('Agent')
  })

  it('keeps General and two specialists apart after their Sessions were replaced, and a removed one named', () => {
    const later = memberDirectory({ members: [
      { ...general, public_conversation_id: 's-g2' },
      { ...analyst, public_conversation_id: 's-a2' },
      removedWriter,
    ], general_id: 'g' }, 'ready')
    const names = [
      agent('s-g', { author_member_id: 'g' }),
      agent('s-a', { author_member_id: 'a' }),
      agent('s-a2', { author_member_id: 'a' }),
      agent('s-w', { author_member_id: 'w' }),
    ].map((message) => authorView(message, later, [], t))
    expect(names.map((view) => view.name)).toEqual(['General', 'Analyst', 'Analyst', 'Writer'])
    expect(new Set(names.map((view) => view.key)).size).toBe(3)
    expect(names[3].attention?.label).toBe('Removed')
  })

  it('names the researcher and Kubecode notes', () => {
    expect(authorView(channelMessage(1), directory, [], t).name).toBe('You')
    expect(authorView(channelMessage(1, { author_kind: 'system', kind: 'system' }), directory, [], t).name).toBe('Kubecode')
  })
})

describe('messageRecipients', () => {
  it('names mentioned members through the projection, then the current Sessions', () => {
    const message = channelMessage(1, {
      mentions: [{ session_id: 's-old' }, { session_id: 's-w' }, { session_id: 's-solo' }, { session_id: 's-x' }],
      mention_member_ids: ['a', null, null, null],
    })
    const recipients = messageRecipients(message, directory, [session], t)
    expect(recipients.kind).toBe('members')
    if (recipients.kind !== 'members') return
    expect(recipients.members.map((view) => view.name)).toEqual(['Analyst', 'Writer', 'Solo exploration', 'Unknown agent'])
    expect(recipients.handedOff).toBe(false)
  })

  it('says an agent handed off to the members it named', () => {
    const recipients = messageRecipients(
      channelMessage(1, { author_kind: 'agent', author_ref: 's-g', mentions: [{ session_id: 's-a' }] }),
      directory,
      [],
      t,
    )
    expect(recipients).toMatchObject({ kind: 'members', handedOff: true })
  })

  it('sends what the researcher writes to no one in particular to the project manager', () => {
    expect(messageRecipients(channelMessage(1), directory, [], t)).toEqual({ kind: 'manager', manager: memberView(general, t) })
    expect(messageRecipients(channelMessage(1), memberDirectory(null, 'loading'), [], t)).toEqual({ kind: 'manager', manager: null })
  })

  it('names no one for an agent that named no one, a Kubecode note, or a reply inside a Thread', () => {
    expect(messageRecipients(channelMessage(1, { author_kind: 'agent', author_ref: 's-a' }), directory, [], t).kind).toBe('none')
    expect(messageRecipients(channelMessage(1, { author_kind: 'system', kind: 'system' }), directory, [], t).kind).toBe('none')
    expect(messageRecipients(channelMessage(1, { thread_id: 't1' }), directory, [], t).kind).toBe('none')
  })
})
