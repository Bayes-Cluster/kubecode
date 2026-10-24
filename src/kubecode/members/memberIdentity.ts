import type { MemberRoleKind } from '@/components/workspace/MemberIdentity'
import type { StatusTone } from '../statusTone'
import type { Translator } from '@/lib/i18n'

import type { ChannelMessage, Conversation, Member } from '../api'
import type { MemberDirectory } from './memberDirectory'
import { STATE_LABELS, TEMPLATE_LABELS } from './memberModel'

/**
 * Who someone in a Workspace conversation is, ready for `MemberIdentity`
 * (ADR 0227, ADR 0229 §1). `key` is stable per party, so two views of one
 * member compare equal and two members never do.
 */
export type IdentityView = {
  key: string
  name: string
  handle?: string
  role: MemberRoleKind
  roleLabel?: string
  /** A membership state that needs the researcher; an active member has none. */
  attention?: { label: string; tone: StatusTone }
  /** Only for a live member: the name opens the profile. */
  memberId?: string
}

/** A member: name, handle, and role in words; membership only when it needs attention. */
export function memberView(item: Member, t: Translator): IdentityView {
  const manager = item.role === 'general'
  const view: IdentityView = {
    key: `member:${item.id}`,
    name: item.name,
    handle: item.handle,
    role: manager ? 'manager' : 'specialist',
    roleLabel: manager
      ? t('kubecode.members.template.general')
      : t('kubecode.identity.specialist', { responsibility: t(TEMPLATE_LABELS[item.template]) }),
  }
  if (item.state === 'removed') return { ...view, attention: { label: t(STATE_LABELS.removed), tone: 'muted' } }
  if (item.state === 'setup_required') {
    return { ...view, attention: { label: t(STATE_LABELS.setup_required), tone: 'warn' }, memberId: item.id }
  }
  return { ...view, memberId: item.id }
}

export function researcherView(t: Translator): IdentityView {
  return { key: 'researcher', name: t('kubecode.channel.author.researcher'), role: 'researcher' }
}

export function systemView(t: Translator): IdentityView {
  return { key: 'system', name: t('kubecode.channel.author.system'), role: 'system' }
}

/**
 * Whoever a Session is: its member (through the server's projection, or the
 * member's current Session when the projection is missing), a Session that is
 * no member's by its title, or an agent Kubecode cannot name. Never "Agent",
 * and never a member it is not.
 */
function sessionParty(
  sessionId: string | null,
  projected: string | null | undefined,
  directory: MemberDirectory,
  sessions: readonly Conversation[],
  t: Translator,
): IdentityView {
  const memberId = projected ?? (sessionId ? directory.byCurrentSession.get(sessionId) : undefined)
  const known = memberId ? directory.byId.get(memberId) : undefined
  if (known) return memberView(known, t)
  const session = sessionId ? sessions.find((item) => item.id === sessionId) : undefined
  if (session?.title) {
    return { key: `session:${session.id}`, name: session.title, role: 'specialist', roleLabel: t('kubecode.identity.session') }
  }
  return {
    key: `unknown:${sessionId ?? ''}`,
    name: t('kubecode.identity.unknownAgent'),
    role: 'specialist',
    roleLabel: t('kubecode.identity.notMember'),
  }
}

/** Who wrote a message. */
export function authorView(
  message: ChannelMessage,
  directory: MemberDirectory,
  sessions: readonly Conversation[],
  t: Translator,
): IdentityView {
  if (message.author_kind === 'system') return systemView(t)
  if (message.author_kind === 'researcher') return researcherView(t)
  return sessionParty(message.author_ref, message.author_member_id, directory, sessions, t)
}

/** Whom a message was for, as it was routed (ADR 0223, ADR 0229 §5). */
export type RecipientsView =
  | { kind: 'members'; members: IdentityView[]; handedOff: boolean }
  | { kind: 'manager'; manager: IdentityView | null }
  | { kind: 'none' }

export function messageRecipients(
  message: ChannelMessage,
  directory: MemberDirectory,
  sessions: readonly Conversation[],
  t: Translator,
): RecipientsView {
  if (message.mentions.length > 0) {
    return {
      kind: 'members',
      handedOff: message.author_kind === 'agent',
      members: message.mentions.map((mention, index) => sessionParty(
        mention.session_id,
        message.mention_member_ids?.[index],
        directory,
        sessions,
        t,
      )),
    }
  }
  // What the researcher writes at the top level and names no one in goes to the manager.
  if (message.author_kind === 'researcher' && message.kind === 'message' && message.thread_id === null) {
    return { kind: 'manager', manager: directory.manager ? memberView(directory.manager, t) : null }
  }
  return { kind: 'none' }
}
