/**
 * Where a Project context reference opens, so a reference chip opens the same
 * way everywhere (ADR 0228 §3): a Task in the inspector, a Thread or the
 * channel in General, a Session as execution history, a work item on Kanban
 * with its Task, and every other record as a live resource in the inspector.
 */

import type { ProjectContextRef } from '../../api'
import type { InspectorEntry } from './inspector'
import type { PlaceTarget } from './workspaceLocation'

export type ReferenceTarget =
  | { inspect: InspectorEntry }
  | { place: PlaceTarget }
  | { session: string }
  /** A work item: its Task is read from the work item, then shown on Kanban. */
  | { work: string }

export function inspectorTargetForReference(ref: ProjectContextRef): ReferenceTarget {
  switch (ref.kind) {
    case 'research': return { inspect: { kind: 'task', id: ref.id } }
    case 'thread': return { place: { view: 'general', thread: ref.id } }
    case 'channel': return { place: { view: 'general' } }
    case 'session': return { session: ref.id }
    case 'work': return { work: ref.id }
    // A resource is shown live: a chip's revision is a change fingerprint, not a pin.
    default: return { inspect: { kind: 'resource', ref: { kind: ref.kind, id: ref.id } } }
  }
}
