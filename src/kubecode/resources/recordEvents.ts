/**
 * Which Workspace events can change a record of each kind (ADR 0231 §4).
 * Events only ever mark what is shown as possibly out of date; nothing is
 * re-read or reflowed under the reader because of one. Pure.
 */

import type { ProjectContextKind, WorkspaceEvent } from '../api'

const BY_EVENT: Record<string, readonly ProjectContextKind[]> = {
  research_updated: ['research', 'round', 'finding', 'import', 'experiment', 'artifact'],
  task_updated: ['research', 'round', 'finding', 'import', 'experiment', 'artifact'],
  work_updated: ['work', 'team_task'],
  team_task_updated: ['team', 'team_task'],
  channel_updated: ['thread'],
  file_changed: ['file', 'artifact'],
  member_updated: ['session'],
  session_updated: ['session'],
  session_removed: ['session'],
}

/** Whether `event` may have changed a record of `kind` (`id`, for a file) in this Project. */
export function eventTouches(
  event: WorkspaceEvent,
  projectId: string,
  kind: ProjectContextKind,
  id?: string,
): boolean {
  if (event.project_id !== null && event.project_id !== projectId) return false
  if (!BY_EVENT[event.kind]?.includes(kind)) return false
  if (event.kind === 'file_changed' && kind === 'file' && id !== undefined) {
    const payload = event.payload as { paths?: unknown; full?: unknown }
    if (payload.full === true || !Array.isArray(payload.paths)) return true
    return payload.paths.some((path) => typeof path === 'string' && (path === id || id.startsWith(`${path.replace(/\/$/, '')}/`)))
  }
  return true
}

/** Whether any event in `kinds` arrived after `since`. */
export function changedSince(
  events: readonly WorkspaceEvent[],
  since: number,
  projectId: string,
  kinds: readonly ProjectContextKind[],
): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.id <= since) break
    if (kinds.some((kind) => eventTouches(event, projectId, kind))) return true
  }
  return false
}

export function lastEventId(events: readonly WorkspaceEvent[]): number {
  return events.length > 0 ? events[events.length - 1].id : 0
}
