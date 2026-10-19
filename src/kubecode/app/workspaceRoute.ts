/**
 * Where the researcher is in a Workspace, as a value that survives a reload,
 * the back button, and a shared link (ADR 0224).
 *
 * The route lives in the URL *hash* (`#/p/<project>/general/m/<message>`), so
 * it never changes the path the server serves and works under any configured
 * base path (`/user/alice/kubecode/#/…`). Ids are opaque; nothing but ids and
 * view names appears in a route.
 */

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
}

const VIEWS: readonly WorkspaceView[] = ['sessions', 'general', 'board', 'resources', 'members', 'dm', 'question']

/** An id as it may appear in a route: no separators, query characters, or controls. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function safe(value: string | null | undefined): string | undefined {
  return value && SAFE_ID.test(value) ? value : undefined
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
  const query = new URLSearchParams()
  if (route.task) query.set('task', route.task)
  if (route.view === 'general' && route.filter) query.set('filter', route.filter)
  if (route.view === 'general' && route.thread) query.set('thread', route.thread)
  if (route.view === 'members' && route.member) query.set('member', route.member)
  const text = query.toString()
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
