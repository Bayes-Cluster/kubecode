/**
 * Where the researcher is in each Workspace, and where they were in every view
 * they visited there (ADR 0228 §2). One pure reducer is the only owner of the
 * shell's place: the active Project stays the shell's selection, and the
 * location is looked up by it (`locationOf`), never copied.
 *
 * A location is a place plus an inspector stack, ids and view names only. A
 * Workspace without memory is on General; nothing ever falls back to the
 * Sessions surface, which is a place like any other (`{ view: 'sessions' }`).
 */

import type { WorkspaceRoute } from '../workspaceRoute'
import {
  applyInspect,
  MAX_INSPECTOR_DEPTH,
  popEntry,
  sameEntry,
  type InspectMode,
  type InspectorEntry,
  type InspectorStack,
} from './inspector'

export type GeneralPlace = { view: 'general'; message?: string; filter?: string; thread?: string }
export type Place =
  | GeneralPlace
  | { view: 'board' }
  | { view: 'resources' }
  /** Everything that waits for the researcher (ADR 0234); it hosts no inspector. */
  | { view: 'needs-you' }
  | { view: 'members' }
  /** A private conversation, by member id. */
  | { view: 'dm'; member: string }
  /** Execution history, with the Session of this Workspace it showed. */
  | { view: 'sessions'; conversation?: string }
  /** A legacy research question. */
  | { view: 'question'; question: string }
export type InspectorHostView = 'general' | 'board' | 'resources' | 'members' | 'dm'
/** The inspector is always `[]` on the Sessions surface, Needs you, and a question. */
export type WorkspaceLocation = { place: Place; inspector: InspectorStack }
export type ViewKey =
  | 'general' | 'board' | 'resources' | 'needs-you' | 'members' | 'sessions' | `dm:${string}` | `question:${string}`
export type WorkspaceMemory = {
  current: ViewKey
  /** Most recently written last (insertion order is the views' LRU order). */
  views: Partial<Record<ViewKey, WorkspaceLocation>>
  /** The `seq` of the last write, for the Workspaces' LRU order. */
  at: number
}
export type LocationMemory = { lastProjectId: string | null; workspaces: Record<string, WorkspaceMemory>; seq: number }

export const MAX_REMEMBERED_WORKSPACES = 50
/** Per Workspace. Private conversations and questions go first; General never goes. */
export const MAX_REMEMBERED_VIEWS = 12
export const EMPTY_MEMORY: LocationMemory = Object.freeze({
  lastProjectId: null,
  workspaces: Object.freeze({}) as Record<string, WorkspaceMemory>,
  seq: 0,
})

/** What callers ask for: an undefined field keeps the remembered value, `null` deletes it. */
export type PlaceTarget =
  | { view: 'general'; message?: string | null; filter?: string | null; thread?: string | null }
  | { view: 'board' }
  | { view: 'resources' }
  | { view: 'needs-you' }
  | { view: 'members' }
  | { view: 'dm'; member: string }
  | { view: 'sessions'; conversation?: string | null }
  | { view: 'question'; question: string }

export type GeneralPatch = { message?: string | null; filter?: string | null; thread?: string | null }
export type ReconcileFacts = {
  /** The live roster; a member outside it is unknown. */
  memberIds?: ReadonlySet<string>
  removedMemberIds?: ReadonlySet<string>
  /** This Project's Sessions. */
  conversationIds?: ReadonlySet<string>
  /** Sessions just removed from Kubecode. */
  removedConversationIds?: ReadonlySet<string>
}
export type LocationAction =
  | {
    type: 'go'
    projectId: string
    target: PlaceTarget
    /** `remembered` (default): the view's own stack; `keep`: the stack on screen now. */
    inspector?: InspectorStack | 'keep' | 'remembered'
  }
  | { type: 'patchGeneral'; projectId: string; patch: GeneralPatch }
  | { type: 'patchSessions'; projectId: string; conversation: string | null }
  | { type: 'inspect'; projectId: string; entry: InspectorEntry; mode: InspectMode }
  | { type: 'inspectorBack'; projectId: string }
  | { type: 'inspectorClose'; projectId: string }
  /** An exact write of the current view: a link, Back/Forward, or startup. */
  | { type: 'applyRoute'; projectId: string; location: WorkspaceLocation }
  /** `fresh` forgets the Workspace's memory, so it opens General. */
  | { type: 'enterWorkspace'; projectId: string; fresh?: boolean }
  | { type: 'reconcile'; projectId: string; facts: ReconcileFacts }
  | { type: 'forgetWorkspace'; projectId: string }
  | { type: 'prune'; projectIds: readonly string[] }

const EMPTY_STACK: InspectorStack = Object.freeze([]) as InspectorStack
const GENERAL_LOCATION: WorkspaceLocation = Object.freeze({ place: Object.freeze({ view: 'general' }), inspector: EMPTY_STACK })

export function viewKeyOf(place: Place | PlaceTarget): ViewKey {
  switch (place.view) {
    case 'dm': return `dm:${place.member}`
    case 'question': return `question:${place.question}`
    default: return place.view
  }
}

export function hostsInspector(place: Place): place is Extract<Place, { view: InspectorHostView }> {
  return place.view !== 'sessions' && place.view !== 'question' && place.view !== 'needs-you'
}

/** Where an entry is opened from a place that hosts no inspector. */
export function homeViewFor(entry: InspectorEntry): PlaceTarget {
  switch (entry.kind) {
    case 'task': return { view: 'board' }
    case 'member': return { view: 'members' }
    default: return { view: 'resources' }
  }
}

/** The location a view key names when nothing is remembered for it. */
function defaultLocation(key: ViewKey): WorkspaceLocation {
  if (key === 'general') return GENERAL_LOCATION
  if (key.startsWith('dm:')) return { place: { view: 'dm', member: key.slice('dm:'.length) }, inspector: EMPTY_STACK }
  if (key.startsWith('question:')) {
    return { place: { view: 'question', question: key.slice('question:'.length) }, inspector: EMPTY_STACK }
  }
  return { place: { view: key as 'board' | 'resources' | 'needs-you' | 'members' | 'sessions' }, inspector: EMPTY_STACK }
}

function currentKey(workspace: WorkspaceMemory | undefined): ViewKey {
  return workspace?.current ?? 'general'
}

function rememberedLocation(workspace: WorkspaceMemory | undefined, key: ViewKey): WorkspaceLocation {
  return workspace?.views[key] ?? defaultLocation(key)
}

/** The location on screen in a Workspace: its current view as remembered, or General. */
export function locationOf(memory: LocationMemory, projectId: string | null): WorkspaceLocation {
  if (projectId === null) return GENERAL_LOCATION
  const workspace = memory.workspaces[projectId]
  return rememberedLocation(workspace, currentKey(workspace))
}

/**
 * The Workspace to start in: a link's registered Project, then the last one
 * used if it is still registered, then the first.
 */
export function pickInitialWorkspace(
  projects: readonly { id: string }[],
  link: WorkspaceRoute | null,
  memory: LocationMemory,
): string | null {
  const registered = (id: string | null | undefined) => Boolean(id) && projects.some((project) => project.id === id)
  if (registered(link?.project)) return link!.project
  if (registered(memory.lastProjectId)) return memory.lastProjectId
  return projects[0]?.id ?? null
}

// -- Equality ------------------------------------------------------------------------------

function samePlace(a: Place, b: Place): boolean {
  const fields = (place: Place) => Object.entries(place).filter(([, value]) => value !== undefined)
  const left = fields(a)
  const right = new Map(fields(b))
  return left.length === right.size && left.every(([key, value]) => right.get(key) === value)
}

function sameLocation(a: WorkspaceLocation, b: WorkspaceLocation): boolean {
  return samePlace(a.place, b.place)
    && a.inspector.length === b.inspector.length
    && a.inspector.every((entry, index) => sameEntry(entry, b.inspector[index]))
}

// -- Building places -----------------------------------------------------------------------

function patchField<T extends object, K extends keyof T>(place: T, key: K, value: T[K] | null | undefined): T {
  if (value === undefined) return place
  const next = { ...place }
  if (value === null) delete next[key]
  else next[key] = value
  return next
}

function patchGeneralPlace(place: GeneralPlace, patch: GeneralPatch): GeneralPlace {
  let next = patchField(place, 'message', patch.message)
  next = patchField(next, 'filter', patch.filter)
  return patchField(next, 'thread', patch.thread)
}

/** The place a target names, starting from the remembered one. */
function placeFor(target: PlaceTarget, base: Place): Place {
  switch (target.view) {
    case 'general':
      return patchGeneralPlace(base.view === 'general' ? base : { view: 'general' }, target)
    case 'sessions': {
      const remembered = base.view === 'sessions' ? base : { view: 'sessions' as const }
      return patchField(remembered, 'conversation', target.conversation)
    }
    default:
      return target
  }
}

/** A stack where the place hosts one, capped; `[]` where it does not. */
function stackFor(place: Place, stack: InspectorStack): InspectorStack {
  if (!hostsInspector(place) || stack.length === 0) return EMPTY_STACK
  return stack.length > MAX_INSPECTOR_DEPTH ? stack.slice(0, MAX_INSPECTOR_DEPTH) : stack
}

// -- Writing memory ------------------------------------------------------------------------

/** Evicts the least recently used views beyond the cap: never General or the current view. */
function capViews(workspace: WorkspaceMemory): WorkspaceMemory {
  const keys = Object.keys(workspace.views) as ViewKey[]
  if (keys.length <= MAX_REMEMBERED_VIEWS) return workspace
  const evictable = keys.filter((key) => (
    key !== workspace.current && (key.startsWith('dm:') || key.startsWith('question:'))
  ))
  const evicted = new Set(evictable.slice(0, keys.length - MAX_REMEMBERED_VIEWS))
  const views: WorkspaceMemory['views'] = {}
  for (const key of keys) if (!evicted.has(key)) views[key] = workspace.views[key]
  return { ...workspace, views }
}

/** Both limits: views per Workspace, and Workspaces by least recent write. */
export function capMemory(memory: LocationMemory): LocationMemory {
  let changed = false
  const entries = Object.entries(memory.workspaces).map(([projectId, workspace]) => {
    const capped = capViews(workspace)
    if (capped !== workspace) changed = true
    return [projectId, capped] as const
  })
  let kept = entries
  if (entries.length > MAX_REMEMBERED_WORKSPACES) {
    const newest = [...entries].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_REMEMBERED_WORKSPACES)
    const keep = new Set(newest.map(([projectId]) => projectId))
    kept = entries.filter(([projectId]) => keep.has(projectId))
    changed = true
  }
  return changed ? { ...memory, workspaces: Object.fromEntries(kept) } : memory
}

/** Writes one Workspace: bumps `seq`, stamps it, and applies the limits. */
function writeWorkspace(
  memory: LocationMemory,
  projectId: string,
  current: ViewKey,
  views: WorkspaceMemory['views'],
): LocationMemory {
  const seq = memory.seq + 1
  return capMemory({
    ...memory,
    seq,
    workspaces: { ...memory.workspaces, [projectId]: { current, views, at: seq } },
  })
}

/** Makes `location` the current view, most recently used. Unchanged → the same memory. */
function writeCurrent(memory: LocationMemory, projectId: string, location: WorkspaceLocation): LocationMemory {
  const workspace = memory.workspaces[projectId]
  const key = viewKeyOf(location.place)
  const remembered = workspace?.views[key]
  if (workspace && workspace.current === key && remembered && sameLocation(remembered, location)) return memory
  const views: WorkspaceMemory['views'] = {}
  for (const [other, value] of Object.entries(workspace?.views ?? {}) as Array<[ViewKey, WorkspaceLocation]>) {
    if (other !== key) views[other] = value
  }
  views[key] = remembered && sameLocation(remembered, location) ? remembered : location
  return writeWorkspace(memory, projectId, key, views)
}

/** Rewrites the stack of the current view, if it hosts one. */
function writeStack(
  memory: LocationMemory,
  projectId: string,
  next: (stack: InspectorStack) => InspectorStack,
): LocationMemory {
  const location = locationOf(memory, projectId)
  if (!hostsInspector(location.place)) return memory
  const inspector = next(location.inspector)
  if (inspector === location.inspector) return memory
  return writeCurrent(memory, projectId, { place: location.place, inspector: stackFor(location.place, inspector) })
}

function go(
  memory: LocationMemory,
  projectId: string,
  target: PlaceTarget,
  inspector: InspectorStack | 'keep' | 'remembered' = 'remembered',
): LocationMemory {
  const workspace = memory.workspaces[projectId]
  const base = rememberedLocation(workspace, viewKeyOf(target))
  const place = placeFor(target, base.place)
  const stack = inspector === 'remembered'
    ? base.inspector
    : inspector === 'keep' ? locationOf(memory, projectId).inspector : inspector
  return writeCurrent(memory, projectId, { place, inspector: stackFor(place, stack) })
}

// -- Reconciling with what exists now ------------------------------------------------------

function reconcile(memory: LocationMemory, projectId: string, facts: ReconcileFacts): LocationMemory {
  const workspace = memory.workspaces[projectId]
  if (!workspace) return memory
  const memberGone = (id: string) => Boolean(facts.removedMemberIds?.has(id))
    || (facts.memberIds !== undefined && !facts.memberIds.has(id))
  const sessionGone = (id: string | undefined) => id !== undefined && (
    Boolean(facts.removedConversationIds?.has(id))
    || (facts.conversationIds !== undefined && !facts.conversationIds.has(id))
  )
  let current = workspace.current
  let changed = false
  const views: WorkspaceMemory['views'] = {}
  for (const [key, location] of Object.entries(workspace.views) as Array<[ViewKey, WorkspaceLocation]>) {
    const { place } = location
    if ((place.view === 'dm' && memberGone(place.member)) || (place.view === 'sessions' && sessionGone(place.conversation))) {
      if (current === key) current = 'general'
      changed = true
      continue
    }
    const cut = location.inspector.findIndex((entry) => entry.kind === 'member' && memberGone(entry.id))
    if (cut >= 0) {
      views[key] = { place, inspector: stackFor(place, location.inspector.slice(0, cut)) }
      changed = true
    } else {
      views[key] = location
    }
  }
  // A current view remembered only by its key.
  if (current.startsWith('dm:') && memberGone(current.slice('dm:'.length))) {
    current = 'general'
    changed = true
  }
  return changed ? writeWorkspace(memory, projectId, current, views) : memory
}

// -- Forgetting ----------------------------------------------------------------------------

function forget(memory: LocationMemory, keep: (projectId: string) => boolean): LocationMemory {
  const projectIds = Object.keys(memory.workspaces)
  const lastGone = memory.lastProjectId !== null && !keep(memory.lastProjectId)
  if (!lastGone && projectIds.every(keep)) return memory
  return {
    lastProjectId: lastGone ? null : memory.lastProjectId,
    seq: memory.seq + 1,
    workspaces: Object.fromEntries(Object.entries(memory.workspaces).filter(([projectId]) => keep(projectId))),
  }
}

function enterWorkspace(memory: LocationMemory, projectId: string, fresh: boolean): LocationMemory {
  const workspace = memory.workspaces[projectId]
  if (!workspace && memory.lastProjectId === projectId) return memory
  const seq = memory.seq + 1
  const workspaces = { ...memory.workspaces }
  if (fresh) delete workspaces[projectId]
  else if (workspace) workspaces[projectId] = { ...workspace, at: seq }
  return { lastProjectId: projectId, seq, workspaces }
}

export function locationReducer(memory: LocationMemory, action: LocationAction): LocationMemory {
  switch (action.type) {
    case 'go':
      return go(memory, action.projectId, action.target, action.inspector)
    case 'patchGeneral': {
      const location = locationOf(memory, action.projectId)
      if (location.place.view !== 'general') return memory
      const place = patchGeneralPlace(location.place, action.patch)
      return writeCurrent(memory, action.projectId, { place, inspector: location.inspector })
    }
    case 'patchSessions': {
      const location = locationOf(memory, action.projectId)
      if (location.place.view !== 'sessions') return memory
      const place = patchField(location.place, 'conversation', action.conversation)
      return writeCurrent(memory, action.projectId, { place, inspector: EMPTY_STACK })
    }
    case 'inspect': {
      const location = locationOf(memory, action.projectId)
      if (!hostsInspector(location.place)) {
        return go(memory, action.projectId, homeViewFor(action.entry), [action.entry])
      }
      return writeStack(memory, action.projectId, (stack) => applyInspect(stack, action.entry, action.mode))
    }
    case 'inspectorBack':
      return writeStack(memory, action.projectId, popEntry)
    case 'inspectorClose':
      return writeStack(memory, action.projectId, (stack) => (stack.length === 0 ? stack : EMPTY_STACK))
    case 'applyRoute': {
      const { place, inspector } = action.location
      return writeCurrent(memory, action.projectId, { place, inspector: stackFor(place, inspector) })
    }
    case 'enterWorkspace':
      return enterWorkspace(memory, action.projectId, Boolean(action.fresh))
    case 'reconcile':
      return reconcile(memory, action.projectId, action.facts)
    case 'forgetWorkspace':
      return forget(memory, (projectId) => projectId !== action.projectId)
    case 'prune': {
      const registered = new Set(action.projectIds)
      return forget(memory, (projectId) => registered.has(projectId))
    }
  }
}
