import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  KubecodeApi,
  ResearchDetail,
  ResearchEntry,
  ResearchFinding,
  ResearchOutcome,
  ResearchProposal,
  ResearchRound,
  ResearchSummary,
  WorkspaceEvent,
} from '../api'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'

export type ResearchLoadStatus = 'loading' | 'ready' | 'error'

const ENTRY_PAGE = 500
const MAX_ENTRY_PAGES = 10
/** Lifecycle events that change whether a linked Session or Team is still available. */
const LINK_EVENT_PREFIXES = ['session_', 'team_']

/**
 * A value that changes whenever there is a reason to refetch: a matching
 * durable event newer than the ones seen at mount, or a return to a live
 * stream after it dropped (the server replays from the cursor, but a restart
 * or lost cursor is only repaired by reading the authoritative records again).
 */
function useRefreshTick(
  events: WorkspaceEvent[],
  connectionState: WorkspaceConnectionState,
  matches: (event: WorkspaceEvent) => boolean,
): string {
  const [baseline] = useState(() => events.at(-1)?.id ?? 0)
  const [seenConnection, setSeenConnection] = useState(connectionState)
  const [reconnects, setReconnects] = useState(0)
  // Adjusting state while rendering is the supported way to derive from a
  // prop transition without an effect.
  if (seenConnection !== connectionState) {
    setSeenConnection(connectionState)
    if (
      connectionState === 'live'
      && (seenConnection === 'reconnecting' || seenConnection === 'resynchronizing')
    ) {
      setReconnects((value) => value + 1)
    }
  }
  // The newest matching event id only ever grows, so a shed backlog can
  // never hide a new event.
  const latest = useMemo(() => {
    let newest = 0
    for (const event of events) {
      if (event.id > baseline && event.id > newest && matches(event)) newest = event.id
    }
    return newest
  }, [events, baseline, matches])
  // Monotonic, so a shorter retained backlog is never mistaken for news.
  const [highWater, setHighWater] = useState(0)
  if (latest > highWater) setHighWater(latest)
  return `${Math.max(latest, highWater)}:${reconnects}`
}

export type ResearchList = {
  items: ResearchSummary[]
  status: ResearchLoadStatus
  reload: () => void
}

/** The Project's research questions, converged on `research_updated` events. */
export function useResearchList(
  api: KubecodeApi,
  projectId: string | null,
  events: WorkspaceEvent[],
  connectionState: WorkspaceConnectionState,
): ResearchList {
  const [loaded, setLoaded] = useState<{ projectId: string; items: ResearchSummary[] } | null>(null)
  const [failedProjectId, setFailedProjectId] = useState<string | null>(null)
  const [manual, setManual] = useState(0)
  const matchesList = useCallback((event: WorkspaceEvent) => (
    event.kind === 'research_updated' && event.project_id === projectId
  ), [projectId])
  const tick = useRefreshTick(events, connectionState, matchesList)
  const ticket = useRef(0)

  useEffect(() => {
    // Hosts and test doubles without a research surface simply show none.
    if (!projectId || typeof api.listResearch !== 'function') return
    const mine = ++ticket.current
    api.listResearch(projectId, true).then((items) => {
      if (mine !== ticket.current) return
      setLoaded({ projectId, items })
      setFailedProjectId(null)
    }).catch(() => {
      if (mine === ticket.current) setFailedProjectId(projectId)
    })
  }, [api, projectId, tick, manual])

  const current = loaded && loaded.projectId === projectId ? loaded : null
  const unsupported = typeof api.listResearch !== 'function'
  const status: ResearchLoadStatus = current || unsupported
    ? 'ready'
    : failedProjectId === projectId ? 'error' : 'loading'
  return {
    items: current?.items ?? [],
    status,
    reload: useCallback(() => setManual((value) => value + 1), []),
  }
}

export type ResearchBundle = {
  detail: ResearchDetail
  entries: ResearchEntry[]
  findings: ResearchFinding[]
  outcomes: ResearchOutcome[]
  proposals: ResearchProposal[]
  rounds: ResearchRound[]
}

export type ResearchBundleState = {
  bundle: ResearchBundle | null
  status: ResearchLoadStatus
  /** `research_not_found` when the question no longer exists in this Project. */
  errorCode: string | null
  reload: () => void
}

async function loadEntries(api: KubecodeApi, projectId: string, researchId: string) {
  const entries: ResearchEntry[] = []
  let after = 0
  for (let page = 0; page < MAX_ENTRY_PAGES; page += 1) {
    const batch = await api.listResearchEntries(projectId, researchId, after, ENTRY_PAGE)
    entries.push(...batch)
    if (batch.length < ENTRY_PAGE) break
    after = batch[batch.length - 1].seq
  }
  return entries
}

/**
 * One question's brief, discussion, findings, decisions, and rounds. A
 * refresh keeps showing the previous data until the new data lands, and a
 * response that arrives after a newer request (or after switching question)
 * is dropped.
 */
export function useResearchBundle(
  api: KubecodeApi,
  projectId: string | null,
  researchId: string | null,
  events: WorkspaceEvent[],
  connectionState: WorkspaceConnectionState,
): ResearchBundleState {
  const [loaded, setLoaded] = useState<{ key: string; bundle: ResearchBundle } | null>(null)
  const [failure, setFailure] = useState<{ key: string; code: string | null } | null>(null)
  const [manual, setManual] = useState(0)
  const matchesBundle = useCallback((event: WorkspaceEvent) => {
    if (event.project_id !== projectId) return false
    if (event.kind === 'research_updated') return event.payload.research_id === researchId
    return LINK_EVENT_PREFIXES.some((prefix) => event.kind.startsWith(prefix))
  }, [projectId, researchId])
  const tick = useRefreshTick(events, connectionState, matchesBundle)
  const ticket = useRef(0)
  const key = projectId && researchId ? `${projectId}/${researchId}` : null

  useEffect(() => {
    if (!projectId || !researchId || !key) return
    const mine = ++ticket.current
    Promise.all([
      api.getResearch(projectId, researchId),
      loadEntries(api, projectId, researchId),
      api.listResearchFindings(projectId, researchId),
      api.listResearchOutcomes(projectId, researchId),
      api.listResearchProposals(projectId, researchId),
      api.listResearchRounds(projectId, researchId),
    ]).then(([detail, entries, findings, outcomes, proposals, rounds]) => {
      if (mine !== ticket.current) return
      setLoaded({ key, bundle: { detail, entries, findings, outcomes, proposals, rounds } })
      setFailure(null)
    }).catch((cause: unknown) => {
      if (mine !== ticket.current) return
      const code = typeof cause === 'object' && cause && 'code' in cause
        ? String((cause as { code: unknown }).code)
        : null
      setFailure({ key, code })
    })
  }, [api, key, projectId, researchId, tick, manual])

  const current = loaded && loaded.key === key ? loaded.bundle : null
  const failed = failure && failure.key === key ? failure : null
  // A question that is gone is an error even if older data is still held.
  const status: ResearchLoadStatus = failed?.code === 'research_not_found'
    ? 'error'
    : current ? 'ready' : failed ? 'error' : 'loading'
  return {
    bundle: failed?.code === 'research_not_found' ? null : current,
    status,
    errorCode: failed?.code ?? null,
    reload: useCallback(() => setManual((value) => value + 1), []),
  }
}
