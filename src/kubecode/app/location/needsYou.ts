/**
 * What waits for the researcher, as entries that say where each one opens
 * (ADR 0228, ADR 0232). The navigation renders `NeedsYouEntry[]` and opens
 * `target`; it never knows where an entry came from. The entries come from the
 * server's attention projection (`attention/attentionTargets.ts`).
 */

import type { StatusTone } from '../../statusTone'

import type { InspectorEntry } from './inspector'
import type { PlaceTarget } from './workspaceLocation'

export type NeedsYouTarget = {
  place?: PlaceTarget
  inspect?: InspectorEntry
  session?: { projectId: string; conversationId: string }
  /** The `data-focus-key` that holds the decision, focused on arrival. */
  focus?: string
}
export type NeedsYouEntry = {
  /** The decision's identity: `permission:<request>`, `question:<request>`, `proposal:<task>:<revision>`… */
  key: string
  title: string
  reason: { label: string; tone: StatusTone }
  target: NeedsYouTarget
  /** For which Task, by whom, and how long it waits, in words. */
  detail?: string
  group?: 'decision' | 'setup'
  /** `resolving`: answered, until the server's next snapshot drops it. */
  state?: 'waiting' | 'resolving'
}
