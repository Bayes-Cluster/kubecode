/**
 * Where the researcher is in a Workspace, as a value that survives a reload,
 * the back button, and a shared link (ADR 0224).
 *
 * The route lives in the URL *hash* (`#/p/<project>/general/m/<message>`), so
 * it never changes the path the server serves and works under any configured
 * base path (`/user/alice/kubecode/#/…`). Ids are opaque; nothing but ids and
 * view names appears in a route.
 */

import { isRouteId, MAX_INSPECTOR_DEPTH, type InspectorEntry } from './location/inspector'
import { formatInspectorToken, parseInspectorToken } from './location/locationRoute'

export type WorkspaceView =
  /** The Sessions surface (legacy execution detail) with an optional open Session. */
  | 'sessions'
  /** The one public conversation. */
  | 'general'
  /** The one Kanban board. */
  | 'board'
  /** Shared Project context: artifacts, findings, experiments, imports. */
  | 'resources'
  /** The roster of agents. */
  | 'members'
  /** A private conversation with one member. */
  | 'dm'
  /** A legacy research-question workspace opened directly. */
  | 'question'

export type WorkspaceRoute = {
  project: string | null
  view: WorkspaceView
  /** The Session open in the Sessions view. */
  conversation?: string
  /** A message of General to land on, and return to from a detail view. */
  message?: string
  /** A Task shown in the detail pane (a research question id). */
  task?: string
  /** Show only the General messages about this Task. */
  filter?: string
  /** A legacy Thread open beside General. */
  thread?: string
  /** The member of a private conversation or of the profile pane. */
  member?: string
  /** A research question opened directly. */
  question?: string
  /**
   * Inspector entries above the legacy bottom one (`task` / `member`), bottom
   * → top, as repeated `inspect=` parameters (ADR 0228). Only the routable
   * prefix is ever written.
   */
  inspect?: InspectorEntry[]
}

const VIEWS: readonly WorkspaceView[] = ['sessions', 'general', 'board', 'resources', 'members', 'dm', 'question']

function safe(value: string | null | undefined): string | undefined {
  return isRouteId(value) ? value : undefined
}

/** The path part, then the query: `/p/x/general/m/y?task=z`. */
export function formatWorkspaceRoute(route: WorkspaceRoute): string {
  const parts: string[] = []
  if (route.project) parts.push('p', encodeURIComponent(route.project))
  parts.push(route.view)
  switch (route.view) {
    case 'sessions':
      if (route.conversation) parts.push('c', encodeURIComponent(route.conversation))
      break
    case 'general':
      if (route.message) parts.push('m', encodeURIComponent(route.message))
      break
    case 'dm':
      if (route.member) parts.push(encodeURIComponent(route.member))
      break
    case 'question':
      if (route.question) parts.push(encodeURIComponent(route.question))
      break
    default:
      break
  }
  const pairs: Array<[string, string]> = []
  if (route.task) pairs.push(['task', route.task])
  if (route.view === 'general' && route.filter) pairs.push(['filter', route.filter])
  if (route.view === 'general' && route.thread) pairs.push(['thread', route.thread])
  if (route.view === 'members' && route.member) pairs.push(['member', route.member])
  for (const entry of (route.inspect ?? []).slice(0, MAX_INSPECTOR_DEPTH)) {
    const token = formatInspectorToken(entry)
    if (token === null) break
    pairs.push(['inspect', token])
  }
  // Built by hand rather than with URLSearchParams, which would write `~` as
  // `%7E`. For route ids both encode identically (`:` is `%3A` either way), so
  // every route ADR 0224 wrote stays byte for byte the same.
  const text = pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')
  return `/${parts.join('/')}${text ? `?${text}` : ''}`
}

/**
 * The route a hash (or path-and-query string) names. Anything unrecognised or
 * malformed is `null`, never a guess, so a damaged link opens the default view.
 */
export function parseWorkspaceRoute(hash: string): WorkspaceRoute | null {
  const text = hash.replace(/^#/, '')
  if (!text.startsWith('/')) return null
  const [path, queryText = ''] = text.split('?', 2)
  const segments = path.split('/').slice(1).filter((segment) => segment !== '')
  let project: string | null = null
  if (segments[0] === 'p') {
    project = safe(decodeSegment(segments[1])) ?? null
    if (!project) return null
    segments.splice(0, 2)
  }
  const view = segments[0] as WorkspaceView | undefined
  if (!view || !VIEWS.includes(view)) return null
  const route: WorkspaceRoute = { project, view }
  const rest = segments.slice(1)
  switch (view) {
    case 'sessions':
      if (rest[0] === 'c') {
        const conversation = safe(decodeSegment(rest[1]))
        if (!conversation) return null
        route.conversation = conversation
      } else if (rest.length > 0) return null
      break
    case 'general':
      if (rest[0] === 'm') {
        const message = safe(decodeSegment(rest[1]))
        if (!message) return null
        route.message = message
      } else if (rest.length > 0) return null
      break
    case 'dm': {
      const member = safe(decodeSegment(rest[0]))
      if (!member) return null
      route.member = member
      break
    }
    case 'question': {
      const question = safe(decodeSegment(rest[0]))
      if (!question) return null
      route.question = question
      break
    }
    default:
      if (rest.length > 0) return null
  }
  const query = new URLSearchParams(queryText)
  const task = safe(query.get('task'))
  if (task) route.task = task
  if (view === 'general') {
    const filter = safe(query.get('filter'))
    if (filter) route.filter = filter
    const thread = safe(query.get('thread'))
    if (thread) route.thread = thread
  }
  if (view === 'members') {
    const member = safe(query.get('member'))
    if (member) route.member = member
  }
  // The longest valid prefix: a bad token drops itself and everything above it.
  const inspect: InspectorEntry[] = []
  for (const token of query.getAll('inspect').slice(0, MAX_INSPECTOR_DEPTH)) {
    const entry = parseInspectorToken(token)
    if (!entry) break
    inspect.push(entry)
  }
  if (inspect.length > 0) route.inspect = inspect
  return route
}

function decodeSegment(segment: string | undefined): string | undefined {
  if (segment === undefined) return undefined
  try {
    return decodeURIComponent(segment)
  } catch {
    return undefined
  }
}

export function routesEqual(a: WorkspaceRoute | null, b: WorkspaceRoute | null): boolean {
  if (a === null || b === null) return a === b
  return formatWorkspaceRoute(a) === formatWorkspaceRoute(b)
}

/** The hash for a route: `#/p/x/general`. */
export function routeHash(route: WorkspaceRoute): string {
  return `#${formatWorkspaceRoute(route)}`
}
