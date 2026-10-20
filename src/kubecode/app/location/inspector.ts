/**
 * The inspector stack: what is open beside (or over) a Workspace view, as ids
 * only (ADR 0228). The bottom entry was opened from the view; every entry
 * above it was opened from inside the one below (Task → evidence → member).
 *
 * Pure: no React, no storage, no route text. Routes and stored places carry
 * only the *routable* prefix of a stack, so a relative file path never leaves
 * the page.
 */

import type { ProjectContextKind } from '../../api'
import { PROJECT_CONTEXT_KINDS } from '../../projectContext'

/** `file` is review evidence a Task cites by relative path; it is never routable. */
export type InspectorRecordKind = ProjectContextKind | 'file'
export type InspectorRecordRef = { kind: InspectorRecordKind; id: string; revision?: string | null }

export type InspectorEntry =
  /** A Task, by its research question id. */
  | { kind: 'task'; id: string }
  | { kind: 'member'; id: string }
  /** A record as a Task cited it, at its pinned revision; its Task is the nearest task entry below. */
  | { kind: 'evidence'; ref: InspectorRecordRef }
  /** A live Project record. */
  | { kind: 'resource'; ref: InspectorRecordRef }
export type InspectorKind = InspectorEntry['kind']
/** Bottom first; `[]` is a closed inspector. */
export type InspectorStack = readonly InspectorEntry[]
/** `reset` opens from the view, `push` from inside an entry, `replace` swaps the top. */
export type InspectMode = 'reset' | 'push' | 'replace'

export const MAX_INSPECTOR_DEPTH = 4

/** An id as it may appear in a route: no separators, query characters, or controls. */
const ROUTE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export function isRouteId(value: unknown): value is string {
  return typeof value === 'string' && ROUTE_ID.test(value)
}

/** A Project context kind a route may name: never `file`. */
export function isRoutableRecordKind(kind: string): kind is ProjectContextKind {
  return PROJECT_CONTEXT_KINDS.includes(kind)
}

/** `task:r1`, `member:m1`, `evidence:artifact:a1@rev`, `resource:finding:f1`. */
export function entryKey(entry: InspectorEntry): string {
  switch (entry.kind) {
    case 'task':
    case 'member':
      return `${entry.kind}:${entry.id}`
    default: {
      const { kind, id, revision } = entry.ref
      return `${entry.kind}:${kind}:${id}${revision ? `@${revision}` : ''}`
    }
  }
}

export function sameEntry(a: InspectorEntry, b: InspectorEntry): boolean {
  return entryKey(a) === entryKey(b)
}

/**
 * The stack after opening `entry`. An entry already in the stack truncates the
 * stack back to it, so Task → member → Task is [Task] again, never a cycle.
 * Returns the very same stack when nothing changes.
 */
export function applyInspect(stack: InspectorStack, entry: InspectorEntry, mode: InspectMode): InspectorStack {
  if (mode === 'reset') {
    return stack.length === 1 && sameEntry(stack[0], entry) ? stack : [entry]
  }
  const index = stack.findIndex((item) => sameEntry(item, entry))
  if (index >= 0) return index === stack.length - 1 ? stack : stack.slice(0, index + 1)
  if (mode === 'replace' || stack.length >= MAX_INSPECTOR_DEPTH) {
    return [...stack.slice(0, -1), entry]
  }
  return [...stack, entry]
}

/** Back: one entry fewer; popping the last entry closes the inspector. */
export function popEntry(stack: InspectorStack): InspectorStack {
  return stack.length === 0 ? stack : stack.slice(0, -1)
}

/** Whether a route (and so stored memory) may name this entry: ids only, no files. */
export function isRoutable(entry: InspectorEntry): boolean {
  switch (entry.kind) {
    case 'task':
    case 'member':
      return isRouteId(entry.id)
    case 'evidence':
      return isRoutableRecordKind(entry.ref.kind)
        && isRouteId(entry.ref.id)
        && (entry.ref.revision == null || isRouteId(entry.ref.revision))
    case 'resource':
      // A resource is live: its revision is never written.
      return isRoutableRecordKind(entry.ref.kind) && isRouteId(entry.ref.id)
  }
}

/** The stack up to (not including) its first entry a route may not name. */
export function routablePrefix(stack: InspectorStack): InspectorStack {
  const index = stack.findIndex((entry) => !isRoutable(entry))
  return index < 0 ? stack : stack.slice(0, index)
}

/** The Task an entry was opened from: the nearest task entry below `index`. */
export function parentTaskOf(stack: InspectorStack, index: number): string | null {
  for (let below = index - 1; below >= 0; below -= 1) {
    const entry = stack[below]
    if (entry.kind === 'task') return entry.id
  }
  return null
}
