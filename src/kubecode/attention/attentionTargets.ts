/**
 * Needs you from the server's attention projection (ADR 0232): each decision
 * once, worded for the researcher, with the context that holds it. Pure.
 */

import type { Translator } from '@/lib/i18n'

import type { AttentionItem, AttentionSnapshot } from '../api'
import type { InspectorPresentation } from '../app/inspector/useInspectorPresentation'
import type { NeedsYouEntry, NeedsYouTarget } from '../app/location/needsYou'

const TOOL_CHARS = 60
const QUESTION_CHARS = 120

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Whole minutes left, never 0 while it still waits. */
export function minutesLeft(deadlineMs: number): number {
  return Math.max(1, Math.ceil(deadlineMs / 60_000))
}

/** Who asks: the member, or the Session that is no member's. */
export function askerName(item: Pick<AttentionItem, 'member' | 'session_title'>, t: Translator): string {
  return item.member?.name ?? item.session_title ?? t('kubecode.attention.someone')
}

export function setupDetail(code: string | null, t: Translator): string | undefined {
  if (code === 'provider_unavailable') return t('kubecode.attention.setupProvider')
  if (code === 'config_rejected') return t('kubecode.attention.setupConfig')
  return undefined
}

/** Where a decision is made: the Task inspector, General, the DM, the Session, or the member's profile. */
export function attentionTarget(item: AttentionItem, presentation: InspectorPresentation): NeedsYouTarget {
  const side = presentation === 'side'
  switch (item.kind) {
    case 'question':
    case 'review':
      return item.task
        ? { place: { view: 'board' }, inspect: { kind: 'task', id: item.task.id }, focus: `${item.kind}:${item.request_id}` }
        : { place: { view: 'board' }, focus: `${item.kind}:${item.request_id}` }
    case 'proposal':
      return {
        place: { view: 'general', message: item.message_id },
        ...(side ? { inspect: { kind: 'task' as const, id: item.research_id } } : {}),
        focus: `message:${item.message_id}`,
      }
    case 'permission':
    case 'input': {
      const focus = `${item.kind}:${item.request_id}`
      if (item.member && item.binding === 'dm') return { place: { view: 'dm', member: item.member.id }, focus }
      if (item.member) {
        return {
          place: { view: 'general' },
          ...(side && item.task ? { inspect: { kind: 'task' as const, id: item.task.id } } : {}),
          focus,
        }
      }
      return item.conversation_id
        ? { session: { projectId: item.project_id, conversationId: item.conversation_id }, focus }
        : { place: { view: 'general' }, focus }
    }
    case 'setup':
      return {
        place: { view: 'members' },
        inspect: { kind: 'member', id: item.member_id },
        focus: `member-setup:${item.member_id}`,
      }
  }
}

function joined(parts: Array<string | null | undefined>): string | undefined {
  const present = parts.filter((part): part is string => Boolean(part))
  return present.length > 0 ? present.join(' · ') : undefined
}

/** The row's title, badge and detail line. */
export function attentionWords(item: AttentionItem, t: Translator): Pick<NeedsYouEntry, 'title' | 'reason' | 'detail'> {
  const name = askerName(item, t)
  const timesOut = item.deadline_ms !== null ? t('kubecode.attention.timesOut', { minutes: minutesLeft(item.deadline_ms) }) : null
  const forTask = item.task ? t('kubecode.attention.forTask', { task: item.task.title }) : null
  switch (item.kind) {
    case 'permission':
      return {
        title: t('kubecode.attention.permissionTitle', { name, tool: clip(item.tool, TOOL_CHARS) }),
        reason: { label: t('kubecode.nav.needsPermission'), tone: 'warn' },
        detail: joined([forTask, timesOut]),
      }
    case 'input':
      return {
        title: t('kubecode.attention.inputTitle', { name, message: clip(item.message, QUESTION_CHARS) }),
        reason: { label: t('kubecode.nav.needsInputRequest'), tone: 'warn' },
        detail: joined([forTask, timesOut]),
      }
    case 'question':
      return {
        title: clip(item.question, QUESTION_CHARS),
        reason: { label: t('kubecode.nav.needsQuestion'), tone: 'warn' },
        detail: joined([
          item.task ? t('kubecode.attention.inTask', { task: item.task.title }) : null,
          item.member ? t('kubecode.attention.askedBy', { handle: item.member.handle }) : null,
        ]),
      }
    case 'review':
      return {
        title: t('kubecode.attention.reviewTitle', { task: item.task?.title ?? '' }),
        reason: { label: t('kubecode.nav.needsReview'), tone: 'info' },
        detail: item.member ? t('kubecode.attention.requestedBy', { handle: item.member.handle }) : undefined,
      }
    case 'proposal':
      return {
        title: item.task?.title ?? '',
        reason: { label: t(item.admitted ? 'kubecode.nav.needsRevision' : 'kubecode.nav.needsProposal'), tone: 'info' },
        detail: t('kubecode.attention.revisionDetail', { revision: item.revision }),
      }
    case 'setup':
      return {
        title: t('kubecode.attention.setupTitle', { name: item.member?.name ?? '' }),
        reason: { label: t('kubecode.nav.needsSetup'), tone: 'warn' },
        detail: setupDetail(item.setup_code, t),
      }
  }
}

export function needsYouFromAttention(
  snapshot: AttentionSnapshot | null,
  resolving: ReadonlySet<string>,
  t: Translator,
  { presentation }: { presentation: InspectorPresentation },
): NeedsYouEntry[] {
  if (!snapshot) return []
  return snapshot.items.map((item) => ({
    key: item.key,
    ...attentionWords(item, t),
    target: attentionTarget(item, presentation),
    group: item.group,
    state: resolving.has(item.key) ? 'resolving' : 'waiting',
  }))
}
