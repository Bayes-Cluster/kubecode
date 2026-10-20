/**
 * What a cited reference is now (ADR 0231 §5): resolved in batches, cached
 * per Workspace, reference, and cited revision, and forgotten when a relevant
 * Workspace event arrives. The store is plain TypeScript; React reads it
 * through `useReferenceStatus`.
 */

import { createContext, useContext, useEffect, useSyncExternalStore } from 'react'

import type { ReferenceChipProps } from '@/components/workspace/ReferenceChip'
import type { Translator } from '@/lib/i18n'

import type { KubecodeApi, ProjectContextRef, ResearchSourceAvailability, WorkspaceEvent } from '../api'
import { objectKindOf } from '../references/referenceLabels'
import { eventTouches } from './recordEvents'
import { fallbackTitle, formatVersion, kindLabelKey } from './referenceKinds'

export type ReferenceStatus =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; availability: ResearchSourceAvailability; currentRevision: string | null; title: string | null }

/** The server's bound on one resolve. */
export const MAX_RESOLVE = 32
const LOADING: ReferenceStatus = { status: 'loading' }

type Ref = Pick<ProjectContextRef, 'kind' | 'id'> & { revision?: string | null }

const SEP = '\u0000'
const keyOf = (projectId: string, ref: Ref) => [projectId, ref.kind, ref.id, ref.revision ?? ''].join(SEP)

export type ReferenceStatusStore = {
  get(ref: Ref): ReferenceStatus
  request(refs: readonly Ref[]): void
  /** Forgets what a Workspace event may have changed. */
  observe(events: readonly WorkspaceEvent[]): void
  subscribe(listener: () => void): () => void
  version(): number
}

export function createReferenceStatusStore(api: KubecodeApi, projectId: string): ReferenceStatusStore {
  const cache = new Map<string, ReferenceStatus>()
  const inFlight = new Set<string>()
  const listeners = new Set<() => void>()
  let queue: Array<{ key: string; ref: Ref }> = []
  let scheduled = false
  let version = 0
  let lastEvent = 0
  let generation = 0
  const notify = () => {
    version += 1
    listeners.forEach((listener) => listener())
  }
  const flush = () => {
    scheduled = false
    const batch = queue
    queue = []
    const mine = generation
    for (let start = 0; start < batch.length; start += MAX_RESOLVE) {
      const chunk = batch.slice(start, start + MAX_RESOLVE)
      // A resolve that cannot even start is a failure like any other: the chips show no state.
      Promise.resolve()
        .then(() => api.resolveProjectContext(projectId, chunk.map(({ ref }) => ({ kind: ref.kind, id: ref.id, revision: ref.revision ?? null }))))
        .then((resolved) => {
          if (mine !== generation) return
          chunk.forEach(({ key }, index) => {
            inFlight.delete(key)
            const found = resolved[index]
            cache.set(key, found
              ? { status: 'ready', availability: found.availability, currentRevision: found.current_revision, title: found.title ?? null }
              : { status: 'error' })
          })
          notify()
        })
        .catch(() => {
          if (mine !== generation) return
          chunk.forEach(({ key }) => {
            inFlight.delete(key)
            cache.set(key, { status: 'error' })
          })
          notify()
        })
    }
  }
  return {
    get: (ref) => cache.get(keyOf(projectId, ref)) ?? LOADING,
    request(refs) {
      for (const ref of refs) {
        const key = keyOf(projectId, ref)
        if (cache.has(key) || inFlight.has(key)) continue
        inFlight.add(key)
        queue.push({ key, ref })
      }
      if (queue.length > 0 && !scheduled) {
        scheduled = true
        queueMicrotask(flush)
      }
    },
    observe(events) {
      const fresh = events.filter((event) => event.id > lastEvent)
      if (events.length > 0) lastEvent = Math.max(lastEvent, events[events.length - 1].id)
      if (fresh.length === 0) return
      const touched = (key: string) => {
        const [, kind, id] = key.split(SEP)
        return fresh.some((event) => eventTouches(event, projectId, kind as ProjectContextRef['kind'], id))
      }
      let dropped = false
      for (const key of [...cache.keys()]) {
        if (!touched(key)) continue
        cache.delete(key)
        dropped = true
      }
      if ([...inFlight].some(touched)) {
        // An answer already on its way may predate the change: every pending one is asked again.
        generation += 1
        inFlight.clear()
        dropped = true
      }
      if (dropped) notify()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    version: () => version,
  }
}

export const ReferenceStatusContext = createContext<ReferenceStatusStore | null>(null)

const NO_STORE = () => () => undefined

/** The current state of each reference; `loading` outside a provider or until resolved. */
export function useReferenceStatus(refs: readonly Ref[]): ReferenceStatus[] {
  const store = useContext(ReferenceStatusContext)
  useSyncExternalStore(store ? store.subscribe : NO_STORE, () => store?.version() ?? 0)
  const signature = JSON.stringify(refs.map((ref) => [ref.kind, ref.id, ref.revision ?? null]))
  useEffect(() => {
    if (!store) return
    const parsed = JSON.parse(signature) as Array<[ProjectContextRef['kind'], string, string | null]>
    if (parsed.length > 0) store.request(parsed.map(([kind, id, revision]) => ({ kind, id, revision })))
  })
  return refs.map((ref) => (store ? store.get(ref) : LOADING))
}

export type ChipLabel = Pick<ReferenceChipProps, 'kind' | 'kindLabel' | 'title' | 'version' | 'state'>

/**
 * A reference in words (ADR 0231 §5): kind, title (the server's, then what the
 * page knows, then a fallback; never an id), the cited version, and whether it
 * changed since it was cited or attached, no longer exists, or is not
 * available here. A private record is never named.
 */
export function referenceChipLabel(
  ref: Ref,
  status: ReferenceStatus,
  t: Translator,
  options: { basis: 'cited' | 'attached'; knownTitle?: string },
): ChipLabel {
  const ready = status.status === 'ready' ? status : null
  const title = ready?.title ?? options.knownTitle ?? fallbackTitle(ref, t)
  let state: ChipLabel['state']
  if (ready?.availability === 'changed') {
    state = {
      kind: 'changed',
      label: t(options.basis === 'cited' ? 'kubecode.reference.state.changedSinceCited' : 'kubecode.reference.state.changedSinceAttached'),
    }
  } else if (ready?.availability === 'removed') {
    const hidden = ready.title === null && (ref.kind === 'session' || ref.kind === 'session_turn')
    state = hidden
      ? { kind: 'unavailable', label: t('kubecode.reference.state.unavailable') }
      : { kind: 'removed', label: t('kubecode.reference.state.removed') }
  }
  return {
    kind: objectKindOf(ref.kind),
    kindLabel: t(kindLabelKey(ref.kind)),
    title,
    version: formatVersion(ref.kind, ref.revision, t),
    state,
  }
}
