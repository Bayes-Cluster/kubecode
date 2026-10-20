import { useCallback, useEffect, useRef, useState } from 'react'

import {
  ApiError,
  type KubecodeApi,
  type ProjectContextDocument,
  type ProjectContextKind,
  type ProjectContextRef,
  type WorkspaceEvent,
} from '../api'
import { PROJECT_CONTEXT_KINDS } from '../projectContext'
import { eventTouches, lastEventId } from './recordEvents'

export type RecordDocState =
  | { status: 'loading' }
  | { status: 'error'; retry(): void }
  | { status: 'removed' }
  | {
    status: 'ready'
    /** Every page read so far, appended. */
    doc: ProjectContextDocument
    /** The revision whose content is shown (`shown_revision`), never the one asked for. */
    shownRevision: string | null
    /** The record changed after it was opened; what is shown stays. */
    newer: boolean
    /** A file changed between two pages: paging stopped rather than splice two versions. */
    changedWhileReading: boolean
    loadingMore: boolean
    moreFailed: boolean
    loadMore(): void
    /** Reads the current version in place. */
    reload(): void
  }

const READABLE = new Set<string>([...PROJECT_CONTEXT_KINDS, 'file'])

/** What the content read reports as shown; servers before ADR 0231 only had the reference's. */
export function shownRevisionOf(doc: ProjectContextDocument): string | null {
  return doc.shown_revision !== undefined ? doc.shown_revision : doc.ref.revision ?? null
}

type Loaded = {
  key: string
  state:
    | { status: 'error' }
    | { status: 'removed' }
    | { status: 'ready'; doc: ProjectContextDocument; changedWhileReading: boolean; moreFailed: boolean; loadingMore: boolean }
}

/**
 * The one reader of a Workspace record (ADR 0231 §4): the content read, live,
 * a page at a time. A 404, an unknown kind, or a record the server reports as
 * removed is `removed`. A relevant Workspace event is checked with a resolve
 * in the background and only ever raises `newer`.
 */
export function useRecordDocument(
  api: KubecodeApi,
  projectId: string,
  ref: Pick<ProjectContextRef, 'kind' | 'id'>,
  events: readonly WorkspaceEvent[] = [],
): RecordDocState {
  const { id, kind } = ref
  const [attempt, setAttempt] = useState(0)
  const key = `${projectId}|${kind}|${id}|${attempt}`
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const current = loaded && loaded.key === key ? loaded.state : null
  // The newest event when this version was read: only later ones can make it older.
  const baseline = useRef(0)
  const eventsRef = useRef(events)
  useEffect(() => { eventsRef.current = events })
  const [newer, setNewer] = useState<{ key: string } | null>(null)

  useEffect(() => {
    let live = true
    baseline.current = lastEventId(eventsRef.current)
    if (!READABLE.has(kind)) return () => { live = false }
    api.readProjectContext(projectId, { kind: kind as ProjectContextKind, id }, 'content').then(
      (doc) => {
        if (!live) return
        setLoaded({
          key,
          state: doc.availability === 'removed'
            ? { status: 'removed' }
            : { status: 'ready', doc, changedWhileReading: false, moreFailed: false, loadingMore: false },
        })
      },
      (cause) => {
        if (!live) return
        setLoaded({ key, state: cause instanceof ApiError && cause.status === 404 ? { status: 'removed' } : { status: 'error' } })
      },
    )
    return () => { live = false }
  }, [api, id, key, kind, projectId])

  // A relevant change after reading: ask whether this record moved on.
  const ready = current?.status === 'ready' ? current : null
  const shown = ready ? shownRevisionOf(ready.doc) : null
  const checking = useRef(false)
  useEffect(() => {
    if (!ready || newer?.key === key || checking.current) return
    const latest = lastEventId(events)
    if (latest <= baseline.current) return
    const touched = events.some((event) => event.id > baseline.current
      && eventTouches(event, projectId, kind as ProjectContextKind, id))
    baseline.current = latest
    if (!touched || typeof api.resolveProjectContext !== 'function') return
    checking.current = true
    api.resolveProjectContext(projectId, [{ kind: kind as ProjectContextKind, id }])
      .then(([resolved]) => {
        if (resolved && (resolved.availability === 'removed' || resolved.current_revision !== shown)) {
          setNewer({ key })
        }
      })
      .catch(() => undefined)
      .finally(() => { checking.current = false })
  }, [api, events, id, key, kind, newer, projectId, ready, shown])

  const loadMore = useCallback(() => {
    if (!ready || !ready.doc.next_cursor || ready.loadingMore) return
    const cursor = ready.doc.next_cursor
    const patch = (next: (state: Extract<Loaded['state'], { status: 'ready' }>) => Loaded['state']) => setLoaded(
      (previous) => (previous && previous.key === key && previous.state.status === 'ready'
        ? { key, state: next(previous.state) }
        : previous),
    )
    patch((state) => ({ ...state, loadingMore: true, moreFailed: false }))
    api.readProjectContext(projectId, { kind: kind as ProjectContextKind, id }, 'content', cursor).then(
      (page) => patch((state) => (
        page.availability === 'changed' && page.sections.length === 0
          ? { ...state, loadingMore: false, changedWhileReading: true, doc: { ...state.doc, next_cursor: null } }
          : {
            ...state,
            loadingMore: false,
            doc: {
              ...state.doc,
              sections: [...state.doc.sections, ...page.sections],
              notes: [...state.doc.notes, ...page.notes.filter((note) => !state.doc.notes.includes(note))],
              next_cursor: page.next_cursor,
            },
          })),
      () => patch((state) => ({ ...state, loadingMore: false, moreFailed: true })),
    )
  }, [api, id, key, kind, projectId, ready])

  const reload = useCallback(() => setAttempt((count) => count + 1), [])

  if (!READABLE.has(kind)) return { status: 'removed' }
  if (!current) return { status: 'loading' }
  if (current.status === 'error') return { status: 'error', retry: reload }
  if (current.status === 'removed') return { status: 'removed' }
  return {
    status: 'ready',
    doc: current.doc,
    shownRevision: shownRevisionOf(current.doc),
    newer: newer?.key === key,
    changedWhileReading: current.changedWhileReading,
    loadingMore: current.loadingMore,
    moreFailed: current.moreFailed,
    loadMore,
    reload,
  }
}
