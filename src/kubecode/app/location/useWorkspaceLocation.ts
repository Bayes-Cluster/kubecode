import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { PreferenceStorage } from '../../preferenceStorage'
import type { HistoryMode } from '../useWorkspaceRouteSync'
import { formatWorkspaceRoute } from '../workspaceRoute'
import { routeFromLocation } from './locationRoute'
import { readLocationMemory, writeLocationMemory } from './locationStorage'
import {
  locationOf,
  locationReducer,
  type LocationAction,
  type LocationMemory,
  type WorkspaceLocation,
} from './workspaceLocation'

/** How long moves settle before the remembered places are written. */
export const LOCATION_WRITE_DELAY_MS = 200

export type LocationDispatchOptions = {
  /** `replace`: a quiet change (a reconciled place, a swapped entry) that takes the place of the history entry. */
  history?: HistoryMode
  /** The researcher made this move (not a link, a restore, or a correction). */
  user?: boolean
}

export type WorkspaceLocationState = {
  memory: LocationMemory
  /** Where the researcher is in the active Workspace. */
  location: WorkspaceLocation
  dispatch(action: LocationAction, options?: LocationDispatchOptions): void
  /** The memory after every move so far, for code outside render (the startup Workspace). */
  peek(): LocationMemory
  /** How the address takes the next change; read once by route sync. A new entry by default. */
  takeHistoryMode(): HistoryMode
  /** Whether the researcher has moved, so their choice wins over a link the page was slow to read. */
  userMoved: boolean
  /** Writes the remembered places now (a change made as the page is hidden). */
  flush(): void
}

/**
 * What the address says of a Workspace's place. On the Sessions surface the
 * address names the Session actually open, which the shell owns, so the
 * remembered one never counts as a change of the address.
 */
function addressOf(memory: LocationMemory, projectId: string): string {
  const location = locationOf(memory, projectId)
  if (location.place.view === 'sessions') return `${projectId}|sessions`
  return formatWorkspaceRoute(routeFromLocation(projectId, location))
}

/**
 * The shell's one record of where the researcher is (ADR 0228 §2): the pure
 * location reducer, read from `kubecode:workspace-location:v1` once and
 * written back after moves settle and when the page is hidden. The active
 * Project stays the shell's own; the location is looked up by it.
 */
export function useWorkspaceLocation(
  projectId: string | null,
  storage: PreferenceStorage | null,
): WorkspaceLocationState {
  const [memory, setMemory] = useState(() => readLocationMemory(storage))
  const [userMoved, setUserMoved] = useState(false)
  // Every dispatch reduces from the latest memory, even several in one event.
  const latest = useRef(memory)
  const written = useRef(memory)
  const historyMode = useRef<HistoryMode | null>(null)
  const activeProject = useRef(projectId)
  useEffect(() => { activeProject.current = projectId }, [projectId])

  const dispatch = useCallback((action: LocationAction, options: LocationDispatchOptions = {}) => {
    if (options.user) setUserMoved(true)
    const before = latest.current
    const next = locationReducer(before, action)
    if (next === before) return
    latest.current = next
    setMemory(next)
    // Only a change the address shows (the active Workspace's place) decides how it is written.
    const active = activeProject.current
    const moved = active === null || addressOf(before, active) !== addressOf(next, active)
    if (!moved) return
    // A move made together with a quiet change is still a move.
    historyMode.current = options.history === 'replace' && historyMode.current !== 'push' ? 'replace' : 'push'
  }, [])

  const peek = useCallback(() => latest.current, [])

  const takeHistoryMode = useCallback((): HistoryMode => {
    const mode = historyMode.current ?? 'push'
    historyMode.current = null
    return mode
  }, [])

  const flush = useCallback(() => {
    if (!storage || latest.current === written.current) return
    written.current = latest.current
    writeLocationMemory(storage, latest.current)
  }, [storage])

  useEffect(() => {
    if (memory === written.current) return
    const timer = window.setTimeout(flush, LOCATION_WRITE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [flush, memory])

  useEffect(() => {
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [flush])

  const location = useMemo(() => locationOf(memory, projectId), [memory, projectId])

  return { memory, location, dispatch, flush, peek, takeHistoryMode, userMoved }
}
