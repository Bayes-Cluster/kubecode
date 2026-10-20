import { useCallback, useEffect, useRef, useState } from 'react'

import type { KubecodeApi, ProjectContextItem, ProjectContextKind, WorkspaceEvent } from '../api'
import { usePlaceState } from '../app/location/placeMemory'
import { changedSince, lastEventId } from './recordEvents'

/** One result, identified by its Workspace and reference, so it opens only within that Workspace. */
export type SearchResult = { projectId: string; key: string; item: ProjectContextItem }

type Counts = Partial<Record<ProjectContextKind, number>>

export type WorkspaceSearchState = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  results: SearchResult[]
  nextCursor: string | null
  loadMoreFailed: boolean
  /** The kinds the server says it searched. */
  searched: ProjectContextKind[]
  /** The kinds a cap or a bounded walk cut short. */
  truncatedKinds: ProjectContextKind[]
  counts: Counts
  /** Something these results cover changed since they were read; they stay until Refresh. */
  stale: boolean
}

export type WorkspaceSearchOptions = {
  api: KubecodeApi
  projectId: string
  query: string
  /** Always explicit: an empty list searches nothing. */
  kinds: readonly ProjectContextKind[]
  /** Where the place keeps the last results (page memory only), so coming back shows them at once. */
  cacheKey: string | null
  events: readonly WorkspaceEvent[]
  pageSize?: number
  debounceMs?: number
}

export const SEARCH_DEBOUNCE_MS = 200
const PAGE_SIZE = 20

type Snapshot = {
  /** The Workspace, words, and kinds these results are for. */
  signature: string
  status: 'ready' | 'error'
  results: SearchResult[]
  nextCursor: string | null
  loadMoreFailed: boolean
  searched: ProjectContextKind[]
  truncatedKinds: ProjectContextKind[]
  counts: Counts
  /** The newest Workspace event when they were read. */
  seenEvent: number
}

const resultKey = (item: ProjectContextItem) => `${item.ref.kind}:${item.ref.id}`

function append(results: SearchResult[], projectId: string, items: ProjectContextItem[]): SearchResult[] {
  const seen = new Set(results.map((entry) => entry.key))
  const next = [...results]
  for (const item of items) {
    const key = resultKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    next.push({ projectId, key, item })
  }
  return next
}

/**
 * The one Workspace search core (ADR 0231 §2), shared by Resources, Add
 * context, and the titlebar: debounced, cancelled when superseded, and
 * guarded so a response for another Workspace, query, or scope is dropped.
 * Changes only ever mark results stale; nothing reflows under the reader.
 */
export function useWorkspaceSearch({
  api,
  cacheKey,
  debounceMs = SEARCH_DEBOUNCE_MS,
  events,
  kinds,
  pageSize = PAGE_SIZE,
  projectId,
  query,
}: WorkspaceSearchOptions): WorkspaceSearchState & { loadMore(): void; retry(): void; refresh(): void } {
  const words = query.trim()
  const kindList = kinds.join(',')
  const signature = `${projectId}|${kindList}|${words}`
  const [snapshot, setSnapshot] = usePlaceState<Snapshot | null>(cacheKey && `${cacheKey}#results`, null)
  const [refreshes, setRefreshes] = useState(0)
  const current = snapshot && snapshot.signature === signature ? snapshot : null
  const latest = useRef({ snapshot, events })
  useEffect(() => { latest.current = { snapshot, events } })
  const sequence = useRef(0)
  const handled = useRef<string | null>(null)

  useEffect(() => {
    if (kindList === '') return undefined
    const request = `${signature}#${refreshes}`
    // Results kept for exactly this search (a view returned to) are shown as they are.
    const kept = latest.current.snapshot
    if (handled.current !== request && kept?.signature === signature && kept.status === 'ready' && refreshes === 0) {
      handled.current = request
      return undefined
    }
    handled.current = request
    const controller = new AbortController()
    const mine = ++sequence.current
    const timer = window.setTimeout(() => {
      api.searchProjectContext(projectId, {
        query: words,
        kinds: kindList.split(',') as ProjectContextKind[],
        limit: pageSize,
        signal: controller.signal,
      }).then((page) => {
        if (mine !== sequence.current) return
        setSnapshot({
          signature,
          status: 'ready',
          results: append([], projectId, page.items),
          nextCursor: page.next_cursor,
          loadMoreFailed: false,
          searched: page.searched ?? [],
          truncatedKinds: page.truncated_kinds ?? [],
          counts: page.counts ?? {},
          seenEvent: lastEventId(latest.current.events),
        })
      }).catch(() => {
        if (mine !== sequence.current || controller.signal.aborted) return
        setSnapshot({
          signature, status: 'error', results: [], nextCursor: null, loadMoreFailed: false,
          searched: [], truncatedKinds: [], counts: {}, seenEvent: lastEventId(latest.current.events),
        })
      })
    }, debounceMs)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
      if (sequence.current === mine) sequence.current += 1
    }
  }, [api, debounceMs, kindList, pageSize, projectId, refreshes, setSnapshot, signature, words])

  const loadMore = useCallback(() => {
    const shown = latest.current.snapshot
    if (!shown || shown.signature !== signature || !shown.nextCursor) return
    const mine = ++sequence.current
    api.searchProjectContext(projectId, {
      query: words,
      kinds: kindList.split(',') as ProjectContextKind[],
      limit: pageSize,
      cursor: shown.nextCursor,
    }).then((page) => {
      if (mine !== sequence.current) return
      setSnapshot((previous) => (previous && previous.signature === signature
        ? {
          ...previous,
          results: append(previous.results, projectId, page.items),
          nextCursor: page.next_cursor,
          loadMoreFailed: false,
          truncatedKinds: [...new Set([...previous.truncatedKinds, ...(page.truncated_kinds ?? [])])],
        }
        : previous))
    }).catch(() => {
      if (mine !== sequence.current) return
      setSnapshot((previous) => (previous && previous.signature === signature ? { ...previous, loadMoreFailed: true } : previous))
    })
  }, [api, kindList, pageSize, projectId, setSnapshot, signature, words])

  const refresh = useCallback(() => setRefreshes((count) => count + 1), [])

  if (kindList === '') {
    return {
      status: 'idle', results: [], nextCursor: null, loadMoreFailed: false, searched: [], truncatedKinds: [], counts: {},
      stale: false, loadMore, retry: refresh, refresh,
    }
  }
  if (!current) {
    return {
      status: 'loading', results: [], nextCursor: null, loadMoreFailed: false, searched: [], truncatedKinds: [], counts: {},
      stale: false, loadMore, retry: refresh, refresh,
    }
  }
  return {
    status: current.status,
    results: current.results,
    nextCursor: current.nextCursor,
    loadMoreFailed: current.loadMoreFailed,
    searched: current.searched,
    truncatedKinds: current.truncatedKinds,
    counts: current.counts,
    stale: current.status === 'ready' && changedSince(events, current.seenEvent, projectId, kinds),
    loadMore,
    retry: refresh,
    refresh,
  }
}
