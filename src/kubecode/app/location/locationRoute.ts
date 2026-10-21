/**
 * Between a Workspace location and its route (ADR 0228 §5).
 *
 * Canonical form: the bottom inspector entry keeps the parameter ADR 0224 gave
 * it (`?task=` on General, Kanban, Resources and a private conversation;
 * `?member=` on Members), so every link written under 0224 is written back byte
 * for byte. Every further entry is one repeated `inspect=` token:
 *
 *   task~<id> | member~<id> | evidence~<recordKind>~<id>[~<revision>] | resource~<recordKind>~<id>
 *
 * `~` is outside the route-id alphabet, so it separates unambiguously. Only the
 * routable prefix of a stack is written: file evidence ends it.
 */

import type { WorkspaceRoute } from '../workspaceRoute'
import {
  applyInspect,
  isRoutable,
  isRoutableRecordKind,
  isRouteId,
  MAX_INSPECTOR_DEPTH,
  routablePrefix,
  type InspectorEntry,
} from './inspector'
import type { GeneralPlace, Place, WorkspaceLocation } from './workspaceLocation'

const SEPARATOR = '~'

/** The token naming one entry, or `null` when a route may not name it. */
export function formatInspectorToken(entry: InspectorEntry): string | null {
  if (!isRoutable(entry)) return null
  switch (entry.kind) {
    case 'task':
    case 'member':
      return [entry.kind, entry.id].join(SEPARATOR)
    case 'evidence': {
      const { kind, id, revision } = entry.ref
      return [entry.kind, kind, id, ...(revision ? [revision] : [])].join(SEPARATOR)
    }
    case 'resource':
      return [entry.kind, entry.ref.kind, entry.ref.id].join(SEPARATOR)
  }
}

/** The entry a token names, or `null` for anything malformed, unknown, or unsafe. */
export function parseInspectorToken(text: string): InspectorEntry | null {
  const [kind, ...rest] = text.split(SEPARATOR)
  switch (kind) {
    case 'task':
    case 'member':
      return rest.length === 1 && isRouteId(rest[0]) ? { kind, id: rest[0] } : null
    case 'evidence': {
      const [recordKind, id, revision, ...extra] = rest
      if (extra.length > 0 || !recordKind || !isRoutableRecordKind(recordKind) || !isRouteId(id)) return null
      if (revision !== undefined && !isRouteId(revision)) return null
      return { kind, ref: { kind: recordKind, id, revision: revision ?? null } }
    }
    case 'resource': {
      const [recordKind, id, ...extra] = rest
      if (extra.length > 0 || !recordKind || !isRoutableRecordKind(recordKind) || !isRouteId(id)) return null
      return { kind, ref: { kind: recordKind, id } }
    }
    default:
      return null
  }
}

/** The parameter ADR 0224 gave a bottom entry on this view, if any. */
function legacyBottom(place: Place, entry: InspectorEntry | undefined): 'task' | 'member' | null {
  if (!entry) return null
  if (entry.kind === 'task' && ['general', 'board', 'resources', 'dm'].includes(place.view)) return 'task'
  if (entry.kind === 'member' && place.view === 'members') return 'member'
  return null
}

/**
 * The route of a location. `conversationId` is the Session open on the
 * Sessions surface, which wins over the remembered one.
 */
export function routeFromLocation(
  projectId: string | null,
  location: WorkspaceLocation,
  conversationId?: string | null,
): WorkspaceRoute {
  const { place } = location
  const project = projectId
  switch (place.view) {
    case 'sessions': {
      const conversation = conversationId ?? place.conversation
      return conversation ? { project, view: 'sessions', conversation } : { project, view: 'sessions' }
    }
    case 'question':
      return { project, view: 'question', question: place.question }
    case 'needs-you':
      return { project, view: 'needs-you' }
    default:
      break
  }
  const stack = routablePrefix(location.inspector).slice(0, MAX_INSPECTOR_DEPTH)
  const route: WorkspaceRoute = { project, view: place.view }
  if (place.view === 'general') {
    if (place.message) route.message = place.message
    if (place.filter) route.filter = place.filter
    if (place.thread) route.thread = place.thread
  }
  if (place.view === 'dm') route.member = place.member
  const bottom = stack[0]
  const legacy = legacyBottom(place, bottom)
  if (legacy === 'task' && bottom.kind === 'task') route.task = bottom.id
  if (legacy === 'member' && bottom.kind === 'member') route.member = bottom.id
  const inspect = legacy ? stack.slice(1) : stack
  if (inspect.length > 0) route.inspect = [...inspect]
  return route
}

/** The place a route names. */
function placeOf(route: WorkspaceRoute): Place {
  switch (route.view) {
    case 'sessions':
      return route.conversation ? { view: 'sessions', conversation: route.conversation } : { view: 'sessions' }
    case 'general': {
      const place: GeneralPlace = { view: 'general' }
      if (route.message) place.message = route.message
      if (route.filter) place.filter = route.filter
      if (route.thread) place.thread = route.thread
      return place
    }
    case 'dm':
      return route.member ? { view: 'dm', member: route.member } : { view: 'general' }
    case 'question':
      return route.question ? { view: 'question', question: route.question } : { view: 'general' }
    default:
      return { view: route.view }
  }
}

/** The location a route names: its place, and the stack its parameters spell. */
export function locationFromRoute(route: WorkspaceRoute): WorkspaceLocation {
  const place = placeOf(route)
  if (place.view === 'sessions' || place.view === 'question' || place.view === 'needs-you') return { place, inspector: [] }
  const bottom: InspectorEntry | null = place.view === 'members'
    ? (route.member ? { kind: 'member', id: route.member } : null)
    : (route.task ? { kind: 'task', id: route.task } : null)
  const entries = [...(bottom ? [bottom] : []), ...(route.inspect ?? [])].slice(0, MAX_INSPECTOR_DEPTH)
  const inspector = entries.reduce<readonly InspectorEntry[]>((stack, entry) => applyInspect(stack, entry, 'push'), [])
  return { place, inspector }
}
