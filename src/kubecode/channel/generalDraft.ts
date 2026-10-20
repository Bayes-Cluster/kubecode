/**
 * The unsent General message (ADR 0229 §4–§6): its text, the message it
 * replies to, the Task it is about, its references, and the last send
 * attempt. Recipients are read from the text, the same way the server reads
 * them, so what the To row shows is what is sent. Pure, so the rules are
 * tested without a DOM.
 */

import type { Translator } from '@/lib/i18n'

import type { ChannelMessage, Member, NewChannelMessage, ProjectContextItem, ProjectContextRef } from '../api'
import { canReceive, unavailableReason, type MemberDirectory } from '../members/memberDirectory'
import type { IdentityView } from '../members/memberIdentity'
import { STATE_LABELS } from '../members/memberModel'

/** The server's bound on the members one message can name. */
export const MAX_RECIPIENTS = 8
const EXCERPT = 80

export type DraftReply = { messageId: string; authorName: string; excerpt: string }

export type GeneralDraft = {
  body: string
  reply: DraftReply | null
  /** The Task the message is about: sent as its first research reference. */
  task: string | null
  /** The researcher took the Task off; a reply does not put one back. */
  taskCleared: boolean
  /** Never a research question: that is `task`. */
  references: ProjectContextItem[]
  /** The id of the last send and what it carried, so a retry of the same draft is the same message. */
  attempt: { id: string; signature: string } | null
  /**
   * Why the last send failed, shown with Try again. Kept with the draft, so
   * a send that fails after the researcher left still says so on return.
   */
  failure: string | null
}

/** A private message's draft (ADR 0223): text and the last attempt only. */
export type PlainDraft = { body: string; attempt: { id: string; signature: string } | null }

export function emptyGeneralDraft(filter: string | null): GeneralDraft {
  return { body: '', reply: null, task: filter, taskCleared: false, references: [], attempt: null, failure: null }
}

export function excerptOf(body: string, length = EXCERPT): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length > length ? `${flat.slice(0, length)}…` : flat
}

const HANDLE = 'A-Za-z0-9_-'
const TOKEN = new RegExp(`(^|\\s)@([${HANDLE}]+)(?![${HANDLE}])`, 'g')

type Segment = { text: string; counts: boolean }

/**
 * The draft split into what can address someone and what cannot: fenced
 * code, inline code, and quoted lines (`>`) only ever quote.
 */
function segments(body: string): Segment[] {
  const out: Segment[] = []
  let fenced = false
  body.split('\n').forEach((line, index) => {
    if (index > 0) out.push({ text: '\n', counts: false })
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      out.push({ text: line, counts: false })
      return
    }
    if (fenced || /^\s*>/.test(line)) {
      out.push({ text: line, counts: false })
      return
    }
    line.split(/(`[^`\n]*`)/).forEach((part, piece) => {
      if (part) out.push({ text: part, counts: piece % 2 === 0 })
    })
  })
  return out
}

/** The `@handles` the draft addresses, lowercase, first mention first. */
export function mentionTokens(body: string): string[] {
  const found: string[] = []
  for (const segment of segments(body)) {
    if (!segment.counts) continue
    for (const match of segment.text.matchAll(TOKEN)) {
      const handle = match[2].toLowerCase()
      if (!found.includes(handle)) found.push(handle)
    }
  }
  return found
}

/** Takes every addressing `@handle` out of the draft, with one following space. */
export function removeMention(body: string, handle: string): string {
  const escaped = handle.replace(/[-]/g, '\\-')
  const pattern = new RegExp(`(^|\\s)@${escaped}(?![${HANDLE}]) ?`, 'gi')
  return segments(body)
    .map((segment) => (segment.counts ? segment.text.replace(pattern, '$1') : segment.text))
    .join('')
}

export type DraftRecipients =
  /** The members are not known yet (loading) or could not be read (error): whom it goes to is unknown. */
  | { kind: 'unknown'; status: 'loading' | 'error' }
  | { kind: 'manager'; manager: Member | null }
  | { kind: 'members'; reachable: Member[]; unreachable: Array<{ member: Member; reason: 'needs_setup' | 'removed' }> }

/** The member a handle names: a live member first, then a removed one, so a removed member's mention is never dropped. */
function memberByHandle(handle: string, directory: MemberDirectory): Member | undefined {
  const named = (item: Member) => item.handle.toLowerCase() === handle
  return directory.live.find(named) ?? [...directory.byId.values()].find((item) => item.state === 'removed' && named(item))
}

/**
 * Whom the draft goes to: the members it names (removed ones too, as
 * unreachable), or the project manager when it names none. Unknown until the
 * members are read, so a mention is never mistaken for plain text.
 */
export function draftRecipients(body: string, directory: MemberDirectory): DraftRecipients {
  if (directory.status !== 'ready') return { kind: 'unknown', status: directory.status }
  const named = mentionTokens(body)
    .map((handle) => memberByHandle(handle, directory))
    .filter((item): item is Member => item !== undefined)
  if (named.length === 0) return { kind: 'manager', manager: directory.manager }
  const reachable: Member[] = []
  const unreachable: Array<{ member: Member; reason: 'needs_setup' | 'removed' }> = []
  for (const item of named) {
    const reason = unavailableReason(item)
    if (reason) unreachable.push({ member: item, reason })
    else reachable.push(item)
  }
  return { kind: 'members', reachable, unreachable }
}

/** Why the draft cannot be sent as it is, or null. */
export function sendBlockedReason(recipients: DraftRecipients, t: Translator): string | null {
  if (recipients.kind === 'unknown') {
    return recipients.status === 'loading'
      ? t('kubecode.channel.blocked.membersLoading')
      : t('kubecode.channel.blocked.membersFailed')
  }
  if (recipients.kind === 'manager') {
    return recipients.manager && canReceive(recipients.manager)
      ? null
      : t('kubecode.channel.blocked.managerUnavailable')
  }
  const blocked = recipients.unreachable[0]
  if (blocked) {
    return blocked.reason === 'removed'
      ? t('kubecode.channel.recipientRemoved', { name: blocked.member.name })
      : t('kubecode.channel.recipientUnavailable', { name: blocked.member.name, state: t(STATE_LABELS.setup_required) })
  }
  if (recipients.reachable.length > MAX_RECIPIENTS) {
    return t('kubecode.channel.tooManyRecipients', { max: MAX_RECIPIENTS })
  }
  return null
}

/**
 * Replies to a message: cites it, takes its Task unless the researcher removed
 * the draft's, and addresses its author when that changes who receives it. A
 * specialist who can receive is named; the manager is named only when the
 * draft already names someone else, since a message naming no one reaches it.
 */
export function withReply(
  draft: GeneralDraft,
  message: ChannelMessage,
  author: IdentityView,
  directory: MemberDirectory,
): GeneralDraft {
  const next: GeneralDraft = {
    ...draft,
    reply: { messageId: message.id, authorName: author.name, excerpt: excerptOf(message.body) },
    task: draft.task === null && !draft.taskCleared ? message.task_id : draft.task,
  }
  const writer = author.memberId ? directory.byId.get(author.memberId) : undefined
  if (!writer || !canReceive(writer)) return next
  const tokens = mentionTokens(draft.body)
  if (tokens.includes(writer.handle.toLowerCase())) return next
  const address = writer.role === 'general'
    ? draftRecipients(draft.body, directory).kind === 'members'
    : true
  return address ? { ...next, body: `@${writer.handle} ${draft.body}` } : next
}

const refKey = (ref: Pick<ProjectContextRef, 'kind' | 'id'>) => `${ref.kind}:${ref.id}`

/** The message a draft sends, and its signature: the same draft always signs the same. */
export function toNewMessage(
  draft: GeneralDraft,
  recipients: DraftRecipients,
): { message: NewChannelMessage; signature: string } {
  const references: ProjectContextRef[] = []
  const add = (ref: ProjectContextRef) => {
    if (!references.some((existing) => refKey(existing) === refKey(ref))) references.push(ref)
  }
  if (draft.task) add({ kind: 'research', id: draft.task, revision: null })
  draft.references.forEach((item) => add({ kind: item.ref.kind, id: item.ref.id, revision: item.ref.revision ?? null }))
  const memberIds = recipients.kind === 'members' ? recipients.reachable.map((item) => item.id) : []
  const body = draft.body.trim()
  const replyTo = draft.reply?.messageId ?? null
  return {
    message: { body, mentions: memberIds.map((member_id) => ({ member_id })), references, replyTo },
    signature: JSON.stringify([body, [...memberIds].sort(), references.map(refKey), draft.task, replyTo]),
  }
}
