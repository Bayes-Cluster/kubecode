/**
 * The remembered places of every Workspace, kept across reloads in
 * `kubecode:workspace-location:v1` (ADR 0228 §2).
 *
 * Each remembered view is stored as its formatted route
 * (`/p/p1/board?task=r1`), so storage holds what a link may hold: ids and view
 * names, never a file path (only the routable prefix of a stack is written).
 * On read every route goes through the strict route parser; one that is
 * damaged, or names another Project or another view than its slot, is
 * dropped. Drafts, scroll positions and focus are never stored here.
 */

import { createPreferenceStorage, type PreferenceStorage } from '../../preferenceStorage'
import { formatWorkspaceRoute, parseWorkspaceRoute } from '../workspaceRoute'
import { isRouteId } from './inspector'
import { locationFromRoute, routeFromLocation } from './locationRoute'
import {
  capMemory,
  EMPTY_MEMORY,
  viewKeyOf,
  type LocationMemory,
  type ViewKey,
  type WorkspaceLocation,
  type WorkspaceMemory,
} from './workspaceLocation'

export const LOCATION_STORAGE_KEY = 'kubecode:workspace-location:v1'

type StoredWorkspace = { current: ViewKey; at: number; views: Partial<Record<ViewKey, string>> }
type StoredLocationMemory = { lastProjectId: string | null; seq: number; workspaces: Record<string, StoredWorkspace> }

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const FIXED_VIEW_KEYS: readonly string[] = ['general', 'board', 'resources', 'needs-you', 'members', 'sessions']

function isViewKey(value: unknown): value is ViewKey {
  if (typeof value !== 'string') return false
  if (FIXED_VIEW_KEYS.includes(value)) return true
  const separator = value.indexOf(':')
  if (separator <= 0) return false
  const prefix = value.slice(0, separator)
  return (prefix === 'dm' || prefix === 'question') && isRouteId(value.slice(separator + 1))
}

function stamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

const locationPreferenceStorage = createPreferenceStorage<UnknownRecord>({
  defaultValue: () => ({}),
  key: () => LOCATION_STORAGE_KEY,
  normalize: (value) => (isRecord(value) && isRecord(value.workspaces) ? value : undefined),
})

/** One stored Workspace, keeping only the views its slot may hold. */
function readWorkspace(projectId: string, stored: UnknownRecord): WorkspaceMemory {
  const views: WorkspaceMemory['views'] = {}
  for (const [key, text] of Object.entries(isRecord(stored.views) ? stored.views : {})) {
    if (!isViewKey(key) || typeof text !== 'string') continue
    const route = parseWorkspaceRoute(text)
    if (!route || route.project !== projectId) continue
    const location = locationFromRoute(route)
    if (viewKeyOf(location.place) !== key) continue
    views[key] = location
  }
  return {
    current: isViewKey(stored.current) ? stored.current : 'general',
    at: stamp(stored.at),
    views,
  }
}

export function readLocationMemory(storage: PreferenceStorage | null): LocationMemory {
  if (!storage) return EMPTY_MEMORY
  const stored = locationPreferenceStorage.read(storage)
  if (!isRecord(stored.workspaces)) return EMPTY_MEMORY
  const workspaces: Record<string, WorkspaceMemory> = {}
  for (const [projectId, workspace] of Object.entries(stored.workspaces)) {
    if (isRouteId(projectId) && isRecord(workspace)) workspaces[projectId] = readWorkspace(projectId, workspace)
  }
  // The counter never falls behind a stamp it handed out.
  const seq = Math.max(stamp(stored.seq), ...Object.values(workspaces).map((workspace) => workspace.at))
  return capMemory({
    lastProjectId: isRouteId(stored.lastProjectId) ? stored.lastProjectId : null,
    seq,
    workspaces,
  })
}

export function writeLocationMemory(storage: PreferenceStorage | null, memory: LocationMemory): void {
  if (!storage) return
  const workspaces: Record<string, StoredWorkspace> = {}
  for (const [projectId, workspace] of Object.entries(memory.workspaces)) {
    const views: StoredWorkspace['views'] = {}
    for (const [key, location] of Object.entries(workspace.views) as Array<[ViewKey, WorkspaceLocation]>) {
      views[key] = formatWorkspaceRoute(routeFromLocation(projectId, location))
    }
    workspaces[projectId] = { current: workspace.current, at: workspace.at, views }
  }
  const stored: StoredLocationMemory = { lastProjectId: memory.lastProjectId, seq: memory.seq, workspaces }
  locationPreferenceStorage.write(storage, stored)
}
