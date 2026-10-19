import { useEffect, useRef, useState } from 'react'

import {
  formatWorkspaceRoute,
  parseWorkspaceRoute,
  routeHash,
  type WorkspaceRoute,
} from './workspaceRoute'

/** How long an applied route may take to show up in the shell's own state. */
export const APPLY_TIMEOUT_MS = 4_000

/** The place without its narrowing ids: what "arrived" means for an applied route. */
function coarse(route: WorkspaceRoute): string {
  return `${route.project ?? ''}|${route.view}`
}

/**
 * Keeps the shell's state and the URL hash in step (ADR 0224).
 *
 * - On first load, a valid hash is applied; otherwise the current state is
 *   written so the address always names where the researcher is.
 * - A change of state pushes a history entry, so Back returns to the previous
 *   view and a reload lands where the researcher was. Choosing the first
 *   Session of a Project, which only fills in a place already written, replaces
 *   the entry instead of adding one.
 * - Back/Forward, a pasted link, or an edited hash is applied (once, even though
 *   the browser reports it twice).
 *
 * While an applied route is still being reached (a Project that must load
 * first), intermediate states are not written back over it; if it is not
 * reached within `APPLY_TIMEOUT_MS`, where the researcher is gets written.
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
  const synced = useRef<{ text: string; route: WorkspaceRoute } | null>(null)
  const target = useRef<{ text: string; route: WorkspaceRoute; timer: number } | null>(null)
  const started = useRef(false)
  const applyRef = useRef(apply)
  const [, bump] = useState(0)
  useEffect(() => { applyRef.current = apply }, [apply])
  const text = formatWorkspaceRoute(current)

  const request = (route: WorkspaceRoute) => {
    const wanted = formatWorkspaceRoute(route)
    if (target.current?.text === wanted) return
    if (target.current) window.clearTimeout(target.current.timer)
    synced.current = { text: wanted, route }
    const timer = window.setTimeout(() => {
      // Never reached (an unknown Project, a rejected place): show where we are.
      target.current = null
      bump((value) => value + 1)
    }, APPLY_TIMEOUT_MS)
    target.current = { text: wanted, route, timer }
    applyRef.current(route)
  }

  useEffect(() => {
    if (!ready) return
    if (!started.current) {
      started.current = true
      const requested = parseWorkspaceRoute(window.location.hash)
      if (requested && formatWorkspaceRoute(requested) !== text) {
        request(requested)
        return
      }
      synced.current = { text, route: current }
      window.history.replaceState(window.history.state, '', routeHash(current))
      return
    }
    if (target.current) {
      if (text === target.current.text || coarse(current) === coarse(target.current.route)) {
        window.clearTimeout(target.current.timer)
        target.current = null
        synced.current = { text, route: current }
        // Arrived at the place (or its parent): the address names exactly where we are.
        if (text !== formatWorkspaceRoute(parseWorkspaceRoute(window.location.hash) ?? current)) {
          window.history.replaceState(window.history.state, '', routeHash(current))
        }
        return
      }
      return
    }
    if (text === synced.current?.text) return
    const previous = synced.current?.route
    synced.current = { text, route: current }
    const fillsIn = previous
      && previous.view === 'sessions'
      && current.view === 'sessions'
      && previous.project === current.project
      && !previous.conversation
      && Boolean(current.conversation)
    if (fillsIn) window.history.replaceState(window.history.state, '', routeHash(current))
    else window.history.pushState(window.history.state, '', routeHash(current))
  })

  useEffect(() => {
    const onNavigate = () => {
      const requested = parseWorkspaceRoute(window.location.hash)
      if (!requested) return
      const wanted = formatWorkspaceRoute(requested)
      if (wanted === synced.current?.text && !target.current) return
      request(requested)
    }
    window.addEventListener('popstate', onNavigate)
    window.addEventListener('hashchange', onNavigate)
    return () => {
      window.removeEventListener('popstate', onNavigate)
      window.removeEventListener('hashchange', onNavigate)
      if (target.current) window.clearTimeout(target.current.timer)
    }
    // `request` only reads refs and the latest `apply`.
     
  }, [])
}
