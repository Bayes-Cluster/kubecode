/**
 * What waits for the researcher, as entries that say where each one opens
 * (ADR 0228). The navigation renders `NeedsYouEntry[]` and opens `target`; it
 * never knows where an entry came from, so #220 can replace this adapter with
 * a server projection without touching the navigation or the shell.
 */

import type { StatusTone } from '@/components/workspace/StatusBadge'
import type { Translator } from '@/lib/i18n'

import type { Conversation, TaskCard, TaskDraft } from '../../api'
import type { InspectorEntry } from './inspector'
import type { PlaceTarget } from './workspaceLocation'

export type NeedsYouTarget = {
  place?: PlaceTarget
  inspect?: InspectorEntry
  session?: { projectId: string; conversationId: string }
}
export type NeedsYouEntry = {
  /** Unique per decision waiting: `review:<task>`, `input:<task>`, `proposal:<draft>`, `permission:<session>`. */
  key: string
  title: string
  reason: { label: string; tone: StatusTone }
  target: NeedsYouTarget
}

/**
 * Today's sources: Tasks with results to review or input requested (on the
 * board), proposals not yet on the board (discussed in General), and Sessions
 * waiting for a permission answer (in execution history).
 */
export function needsYouFromCurrentSources(
  tasks: readonly TaskCard[],
  drafts: readonly TaskDraft[],
  sessions: readonly Conversation[],
  t: Translator,
): NeedsYouEntry[] {
  const entries: NeedsYouEntry[] = []
  for (const task of tasks) {
    const review = task.stage === 'review'
    if (!review && task.condition !== 'needs_input') continue
    entries.push({
      key: `${review ? 'review' : 'input'}:${task.id}`,
      title: task.title,
      reason: { label: t(review ? 'kubecode.nav.needsReview' : 'kubecode.nav.needsInput'), tone: 'warn' },
      target: { place: { view: 'board' }, inspect: { kind: 'task', id: task.id } },
    })
  }
  for (const draft of drafts) {
    entries.push({
      key: `proposal:${draft.id}`,
      title: draft.title,
      reason: { label: t('kubecode.nav.needsProposal'), tone: 'info' },
      target: { place: { view: 'general' }, inspect: { kind: 'task', id: draft.id } },
    })
  }
  for (const session of sessions) {
    entries.push({
      key: `permission:${session.id}`,
      title: session.title || t('kubecode.untitledSession'),
      reason: { label: t('kubecode.nav.needsPermission'), tone: 'warn' },
      target: { session: { projectId: session.project_id, conversationId: session.id } },
    })
  }
  return entries
}
