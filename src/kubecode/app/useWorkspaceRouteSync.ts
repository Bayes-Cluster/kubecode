import { useEffect, useRef } from 'react'

import {
  formatWorkspaceRoute,
  parseWorkspaceRoute,
  routeHash,
  type WorkspaceRoute,
} from './workspaceRoute'

/** How long an applied route may take to show up in the shell's own state. */
const APPLY_TIMEOUT_MS = 4_000

/**
 * Keeps the shell's state and the URL hash in step (ADR 0224).
 *
 * - On first load, a valid hash is applied; otherwise the current state is
 *   written so the address always names where the researcher is.
 * - A change of state pushes a history entry, so Back returns to the previous
 *   view and a reload lands where the researcher was.
 * - Back/Forward, a pasted link, or an edited hash is applied.
 *
 * While an applied route is still being reached (a Project that must load
 * first), intermediate states are not written back over it.
 */
export function useWorkspaceRouteSync({
  apply,
  current,
  ready,
}: {
  apply: (route: WorkspaceRoute) => void
  current: WorkspaceRoute
  /** The shell has its Projects and can honour a route. */
  ready: boolean
}) {
  const synced = useRef<string | null>(null)
  const target = useRef<{ text: string; since: number } | null>(null)
  const started = useRef(false)
  const applyRef = useRef(apply)
  useEffect(() => { applyRef.current = apply }, [apply])
  const text = formatWorkspaceRoute(current)

  useEffect(() => {
    if (!ready) return
    if (!started.current) {
      started.current = true
      const requested = parseWorkspaceRoute(window.location.hash)
      if (requested && formatWorkspaceRoute(requested) !== text) {
        const wanted = formatWorkspaceRoute(requested)
        synced.current = wanted
        target.current = { text: wanted, since: Date.now() }
        applyRef.current(requested)
        return
      }
      synced.current = text
      window.history.replaceState(window.history.state, '', routeHash(current))
      return
    }
    if (target.current) {
      if (text === target.current.text) {
        target.current = null
        synced.current = text
        return
      }
      if (Date.now() - target.current.since < APPLY_TIMEOUT_MS) return
      // The requested place could not be reached: show where we are instead.
      target.current = null
    }
    if (text === synced.current) return
    synced.current = text
    window.history.pushState(window.history.state, '', routeHash(current))
  }, [current, ready, text])

  useEffect(() => {
    const onNavigate = () => {
      const requested = parseWorkspaceRoute(window.location.hash)
      if (!requested) return
      const wanted = formatWorkspaceRoute(requested)
      if (wanted === synced.current && !target.current) return
      synced.current = wanted
      target.current = { text: wanted, since: Date.now() }
      applyRef.current(requested)
    }
    window.addEventListener('popstate', onNavigate)
    window.addEventListener('hashchange', onNavigate)
    return () => {
      window.removeEventListener('popstate', onNavigate)
      window.removeEventListener('hashchange', onNavigate)
    }
  }, [])
}
