import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import {
  formatWorkspaceRoute,
  parseWorkspaceRoute,
  routeHash,
  type WorkspaceRoute,
} from './workspaceRoute'

/** How long an applied route may take to show up in the shell's own state. */
export const APPLY_TIMEOUT_MS = 4_000

/** How a changed place is written: a new history entry, or in place of the current one. */
export type HistoryMode = 'push' | 'replace'

/** The place without its narrowing ids: what "arrived" means for an applied route. */
function coarse(route: WorkspaceRoute): string {
  return `${route.project ?? ''}|${route.view}`
}

/** The shell is at the requested place, or at the view it narrows. */
function reached(current: WorkspaceRoute, text: string, requested: WorkspaceRoute): boolean {
  return text === formatWorkspaceRoute(requested) || coarse(current) === coarse(requested)
}

/** A valid link in the address that names somewhere other than `text`. */
function initialLink(text: string): WorkspaceRoute | null {
  const requested = parseWorkspaceRoute(window.location.hash)
  return requested && formatWorkspaceRoute(requested) !== text ? requested : null
}

/** A value outside React state that components read with `useSyncExternalStore`. */
function createRouteStore(initial: WorkspaceRoute | null) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next: WorkspaceRoute | null) {
      if (next === value) return
      value = next
      listeners.forEach((listener) => listener())
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/**
 * Keeps the shell's state and the URL hash in step (ADR 0224, ADR 0228).
 *
 * - On first load, a valid hash is applied; otherwise the current state is
 *   written so the address always names where the researcher is.
 * - A change of state pushes a history entry, so Back returns to the previous
 *   place and a reload lands where the researcher was. The shell may ask for a
 *   quiet change (`historyMode` returns `replace`: a reading position, a
 *   reconciled place) that replaces the entry instead. Choosing the first
 *   Session of a Project, which only fills in a place already written, also
 *   replaces it.
 * - Back/Forward, a pasted link, or an edited hash is applied (once, even though
 *   the browser reports it twice).
 *
 * While an applied route is still being reached (a Project that must load
 * first), `pending` is true and intermediate states are not written back over
 * it; if it is not reached within `APPLY_TIMEOUT_MS`, where the researcher is
 * gets written. A route `apply` refuses (an unknown Project) is abandoned at
 * once, and the address then names where the researcher is.
 */
export function useWorkspaceRouteSync({
  apply,
  current,
  ready,
  ignoreInitialLink = false,
  historyMode,
}: {
  /** Moves the shell to the route; false when it cannot be honoured (an unknown Project). */
  apply: (route: WorkspaceRoute) => boolean
  current: WorkspaceRoute
  /** The shell has its Projects and can honour a route. */
  ready: boolean
  /**
   * The researcher already moved before the address was first read (the page
   * was slow to load): what they chose wins over the link they opened.
   */
  ignoreInitialLink?: boolean
  /** How the next changed place is written; a new history entry by default. */
  historyMode?: () => HistoryMode
}): { pending: boolean } {
  const synced = useRef<{ text: string; route: WorkspaceRoute } | null>(null)
  const target = useRef<{ text: string; route: WorkspaceRoute; timer: number } | null>(null)
  const started = useRef(false)
  const applyRef = useRef(apply)
  const historyModeRef = useRef(historyMode)
  const text = formatWorkspaceRoute(current)
  const latest = useRef({ text, route: current })
  // The route being reached is settled from the address listeners, the
  // timeout and the sync effect alike, so it lives in a small store that
  // render reads, rather than in state each of them would set.
  const [awaitingStore] = useState(() => createRouteStore(ignoreInitialLink ? null : initialLink(text)))
  const awaiting = useSyncExternalStore(awaitingStore.subscribe, awaitingStore.get)
  useEffect(() => {
    applyRef.current = apply
    historyModeRef.current = historyMode
    latest.current = { text, route: current }
  })

  const request = useCallback((route: WorkspaceRoute) => {
    const wanted = formatWorkspaceRoute(route)
    if (target.current?.text === wanted) return
    if (target.current) window.clearTimeout(target.current.timer)
    synced.current = { text: wanted, route }
    const timer = window.setTimeout(() => {
      // Never reached (a rejected place): show where we are.
      target.current = null
      awaitingStore.set(null)
    }, APPLY_TIMEOUT_MS)
    target.current = { text: wanted, route, timer }
    if (applyRef.current(route)) {
      awaitingStore.set(route)
      return
    }
    // Cannot be honoured: the address names where the researcher is, in place of the link.
    window.clearTimeout(timer)
    target.current = null
    awaitingStore.set(null)
    synced.current = latest.current
    window.history.replaceState(window.history.state, '', routeHash(latest.current.route))
  }, [awaitingStore])

  useEffect(() => {
    if (!ready) return
    if (!started.current) {
      started.current = true
      const requested = ignoreInitialLink ? null : initialLink(text)
      if (requested) {
        request(requested)
        return
      }
      awaitingStore.set(null)
      synced.current = { text, route: current }
      window.history.replaceState(window.history.state, '', routeHash(current))
      return
    }
    if (target.current) {
      if (reached(current, text, target.current.route)) {
        window.clearTimeout(target.current.timer)
        target.current = null
        awaitingStore.set(null)
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
    if (fillsIn || historyModeRef.current?.() === 'replace') {
      window.history.replaceState(window.history.state, '', routeHash(current))
    } else {
      window.history.pushState(window.history.state, '', routeHash(current))
    }
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
  }, [request])

  // Derived, so a place the shell reaches at once never shows as pending.
  return { pending: awaiting !== null && !reached(current, text, awaiting) }
}
