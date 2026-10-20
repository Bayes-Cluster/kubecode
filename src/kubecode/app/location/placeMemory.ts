/**
 * What a place holds that is not part of its address (ADR 0228 §4): unsent
 * drafts, reply targets, and scroll positions, kept per Workspace and
 * destination for the life of the page. Nothing here is written to storage,
 * so private text never reaches disk.
 *
 * Keys start with the Workspace's Project id and a `|` (see `placeKey`), so a
 * Workspace's memory can be forgotten when it is unregistered.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react'

import type { ViewKey } from './workspaceLocation'

/** The destinations a place's memory is kept for. A Task-scoped General is its own place. */
export const placeKey = {
  general: (projectId: string, taskFilter?: string | null) => (
    taskFilter ? `${projectId}|general:task:${taskFilter}` : `${projectId}|general`
  ),
  thread: (projectId: string, threadId: string) => `${projectId}|thread:${threadId}`,
  dm: (projectId: string, memberId: string) => `${projectId}|dm:${memberId}`,
  view: (projectId: string, view: ViewKey) => `${projectId}|view:${view}`,
}

/** Where the researcher is reading in General, as the conversation reports it. */
export type ReadingPosition = {
  /** The message nearest the middle of the log; null when nothing is loaded. */
  messageId: string | null
  /** At the newest message: coming back follows the conversation instead. */
  atLatest: boolean
  /** What last had focus in the conversation. */
  focus: 'composer' | 'message' | null
}

/**
 * How General is arrived at: `quiet` scrolls to the message and leaves focus
 * where it is, `focus` also focuses the message, `composer` focuses the
 * composer. Transient: never part of the address.
 */
export type Landing = 'quiet' | 'focus' | 'composer'

export type PlaceMemory = {
  has(key: string): boolean
  get(key: string): unknown
  set(key: string, value: unknown): void
  subscribe(key: string, listener: () => void): () => void
  /** Forgets one key and everything kept under it (`key#…`). */
  clear(key: string): void
  forgetWorkspace(projectId: string): void
  /** Forgets every Workspace not in `projectIds`. */
  prune(projectIds: readonly string[]): void
}

const workspaceOf = (key: string) => key.slice(0, key.indexOf('|'))

/** One page's memory of places; the shell keeps one. */
export function createPlaceMemory(): PlaceMemory {
  const values = new Map<string, unknown>()
  const listeners = new Map<string, Set<() => void>>()
  const notify = (key: string) => listeners.get(key)?.forEach((listener) => listener())
  const remove = (doomed: (key: string) => boolean) => {
    const gone = [...values.keys()].filter(doomed)
    gone.forEach((key) => values.delete(key))
    gone.forEach(notify)
  }
  return {
    has: (key) => values.has(key),
    get: (key) => values.get(key),
    set(key, value) {
      if (values.has(key) && Object.is(values.get(key), value)) return
      values.set(key, value)
      notify(key)
    },
    subscribe(key, listener) {
      const set = listeners.get(key) ?? new Set()
      set.add(listener)
      listeners.set(key, set)
      return () => {
        set.delete(listener)
        if (set.size === 0) listeners.delete(key)
      }
    },
    clear: (key) => remove((candidate) => candidate === key || candidate.startsWith(`${key}#`)),
    forgetWorkspace: (projectId) => remove((key) => workspaceOf(key) === projectId),
    prune(projectIds) {
      const kept = new Set(projectIds)
      remove((key) => !kept.has(workspaceOf(key)))
    },
  }
}

/** The page's memory of places; `PlaceMemoryProvider` gives it to what is under it. */
export const PlaceMemoryContext = createContext<PlaceMemory | null>(null)

/** The page's memory of places, or null outside a provider. */
export function usePlaceMemory(): PlaceMemory | null {
  return useContext(PlaceMemoryContext)
}

const MISSING = Symbol('missing')
const NO_SUBSCRIPTION = () => () => undefined

/**
 * `useState` whose value outlives the component: kept under `key` for as long
 * as the page lives, so leaving a view and coming back finds it again. With
 * no key, or outside a provider, it is plain component state.
 */
export function usePlaceState<T>(key: string | null, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const memory = useContext(PlaceMemoryContext)
  const [local, setLocal] = useState(initial)
  const initialRef = useRef(initial)
  useEffect(() => { initialRef.current = initial })
  const keyed = memory !== null && key !== null
  const subscribe = useCallback(
    (listener: () => void) => (memory && key !== null ? memory.subscribe(key, listener) : NO_SUBSCRIPTION()),
    [key, memory],
  )
  const stored = useSyncExternalStore(subscribe, () => (
    memory && key !== null && memory.has(key) ? memory.get(key) : MISSING
  ))
  const setValue = useCallback<Dispatch<SetStateAction<T>>>((action) => {
    if (!memory || key === null) {
      setLocal(action)
      return
    }
    const current = (memory.has(key) ? memory.get(key) : initialRef.current) as T
    memory.set(key, typeof action === 'function' ? (action as (value: T) => T)(current) : action)
  }, [key, memory])
  if (!keyed) return [local, setValue]
  return [stored === MISSING ? initial : stored as T, setValue]
}

/**
 * `useRef` whose value outlives the component, for what a place keeps but
 * never draws (the id of a send that may be retried). Writing it renders
 * nothing. With no key, or outside a provider, it is a plain ref.
 */
export function usePlaceRef<T>(key: string | null, initial: T): { current: T } {
  const memory = useContext(PlaceMemoryContext)
  const local = useRef(initial)
  const initialRef = useRef(initial)
  return useMemo(() => {
    if (!memory || key === null) return local
    return {
      get current() {
        return (memory.has(key) ? memory.get(key) : initialRef.current) as T
      },
      set current(value: T) {
        memory.set(key, value)
      },
    }
  }, [key, memory])
}

// -- Scroll positions ----------------------------------------------------------------------

/** How long a restore waits for the content it needs. */
export const SCROLL_RESTORE_WAIT_MS = 3_000
/** Within this of the bottom counts as at the bottom. */
const AT_END_PX = 48

type ScrollSnapshot =
  | { top: number }
  | { atEnd: true }
  | { anchor: string; offset: number; top: number }

function snapshotOf(element: HTMLElement): ScrollSnapshot {
  const top = element.scrollTop
  if (top <= 0) return { top: 0 }
  if (element.scrollHeight - top - element.clientHeight < AT_END_PX) return { atEnd: true }
  const edge = element.getBoundingClientRect().top
  for (const anchor of element.querySelectorAll<HTMLElement>('[data-scroll-anchor]')) {
    const rect = anchor.getBoundingClientRect()
    if (rect.bottom > edge) return { anchor: anchor.dataset.scrollAnchor ?? '', offset: rect.top - edge, top }
  }
  return { top }
}

/** Puts the scroller back; false while the content it needs is not there yet. */
function restoreSnapshot(element: HTMLElement, snapshot: ScrollSnapshot): boolean {
  if ('atEnd' in snapshot) {
    if (element.scrollHeight <= element.clientHeight) return false
    element.scrollTop = element.scrollHeight
    return true
  }
  if ('anchor' in snapshot) {
    const anchor = Array.from(element.querySelectorAll<HTMLElement>('[data-scroll-anchor]'))
      .find((candidate) => candidate.dataset.scrollAnchor === snapshot.anchor)
    if (!anchor) return false
    const delta = anchor.getBoundingClientRect().top - element.getBoundingClientRect().top
    element.scrollTop += delta - snapshot.offset
    return true
  }
  if (snapshot.top === 0) return true
  element.scrollTop = snapshot.top
  return element.scrollTop >= snapshot.top - 1
}

/** The last resort once the content never came: the plain offset. */
function fallBack(element: HTMLElement, snapshot: ScrollSnapshot) {
  if ('anchor' in snapshot) element.scrollTop = snapshot.top
}

const USER_SCROLL_EVENTS = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const

/**
 * Remembers where a list was scrolled to (the first row on screen and its
 * offset, the bottom, or the top) and puts it back once, when the list is
 * `ready` (and `active`) again. Rows carry `data-scroll-anchor`. Restoring
 * waits for content that is still loading, and gives way the moment the
 * researcher scrolls themselves.
 */
export function useScrollMemory(
  ref: RefObject<HTMLElement | null>,
  key: string | null,
  { active = true, ready }: { ready: boolean; active?: boolean },
): void {
  const memory = useContext(PlaceMemoryContext)
  const slot = memory && key !== null ? `${key}#scroll` : null
  // The slot whose remembered position was put back (or found empty): only then is scrolling recorded.
  const settled = useRef<string | null>(null)

  useLayoutEffect(() => {
    const element = ref.current
    if (!memory || !slot || !element) return
    let frame = 0
    const record = () => {
      frame = 0
      if (settled.current === slot) memory.set(slot, snapshotOf(element))
    }
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(record)
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      element.removeEventListener('scroll', onScroll)
      // Leaving before the next frame still keeps where the list was.
      if (frame) {
        window.cancelAnimationFrame(frame)
        record()
      }
    }
  }, [memory, ref, slot])

  useLayoutEffect(() => {
    const element = ref.current
    if (!memory || !slot || !element || !ready || !active || settled.current === slot) return
    const snapshot = memory.get(slot) as ScrollSnapshot | undefined
    if (!snapshot || restoreSnapshot(element, snapshot)) {
      settled.current = slot
      return
    }
    let finished = false
    const finish = (timedOut: boolean) => {
      if (finished) return
      finished = true
      if (timedOut) fallBack(element, snapshot)
      settled.current = slot
      stop()
    }
    const giveWay = () => finish(false)
    const observer = typeof MutationObserver === 'function'
      ? new MutationObserver(() => { if (restoreSnapshot(element, snapshot)) finish(false) })
      : null
    observer?.observe(element, { childList: true, subtree: true })
    const timer = window.setTimeout(() => finish(true), SCROLL_RESTORE_WAIT_MS)
    USER_SCROLL_EVENTS.forEach((type) => element.addEventListener(type, giveWay, { passive: true }))
    const scroller: HTMLElement = element
    function stop() {
      observer?.disconnect()
      window.clearTimeout(timer)
      USER_SCROLL_EVENTS.forEach((type) => scroller.removeEventListener(type, giveWay))
    }
    return stop
  }, [active, memory, ready, ref, slot])
}
