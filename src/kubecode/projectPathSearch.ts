import type { Entry, KubecodeApi } from './api'
import { fuzzyMatchRank } from './fuzzyMatch'

const PATH_MATCH_WEIGHTS = {
  empty: 0,
  exact: 0,
  prefix: 1,
  subsequence: 3,
  substring: 2,
} as const

export function isExcludedProjectEntry(entry: Entry): boolean {
  return Boolean(
    entry.hidden
    || entry.ignored
    || entry.generated,
  )
}

export async function searchProjectEntries({
  api,
  includeExcluded = false,
  kind,
  maxEntries = 2_000,
  maxResults = 100,
  projectId,
  query,
}: {
  api: KubecodeApi
  includeExcluded?: boolean
  kind?: Entry['kind']
  maxEntries?: number
  maxResults?: number
  projectId: string
  query: string
}): Promise<Entry[]> {
  return searchEntries({
    includeExcluded,
    kind,
    listEntries: (path) => api.listEntries(projectId, path),
    maxEntries,
    maxResults,
    query,
  })
}

export async function searchSessionEntries({
  api,
  conversationId,
  includeExcluded = false,
  kind,
  maxEntries = 2_000,
  maxResults = 100,
  query,
  signal,
}: {
  api: KubecodeApi
  conversationId: string
  includeExcluded?: boolean
  kind?: Entry['kind']
  maxEntries?: number
  maxResults?: number
  query: string
  signal?: AbortSignal
}): Promise<Entry[]> {
  return searchEntries({
    includeExcluded,
    kind,
    listEntries: (path) => signal
      ? api.listSessionEntries(conversationId, path, signal)
      : api.listSessionEntries(conversationId, path),
    maxEntries,
    maxResults,
    query,
    signal,
  })
}

async function searchEntries({
  includeExcluded,
  kind,
  listEntries,
  maxEntries,
  maxResults,
  query,
  signal,
}: {
  includeExcluded: boolean
  kind?: Entry['kind']
  listEntries: (path: string) => Promise<Entry[]>
  maxEntries: number
  maxResults: number
  query: string
  signal?: AbortSignal
}): Promise<Entry[]> {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const pending = ['']
  const candidates: Array<{ entry: Entry; order: number; score: number }> = []
  const visitedDirectories = new Set<string>()
  const resultPaths = new Set<string>()
  let visitedEntries = 0
  let order = 0

  while (pending.length > 0 && visitedEntries < maxEntries) {
    signal?.throwIfAborted()
    const directory = pending.shift() as string
    if (visitedDirectories.has(directory)) continue
    visitedDirectories.add(directory)
    const entries = await listEntries(directory)
    signal?.throwIfAborted()
    const boundedEntries = entries.slice(0, Math.max(0, maxEntries - visitedEntries))
    visitedEntries += boundedEntries.length

    for (const entry of boundedEntries) {
      if (!includeExcluded && isExcludedProjectEntry(entry)) continue
      const score = fuzzyPathScore(entry, normalizedQuery)
      if (
        (!kind || entry.kind === kind)
        && score !== null
        && !resultPaths.has(entry.path)
      ) {
        resultPaths.add(entry.path)
        candidates.push({ entry, order: order++, score })
      }
      if (
        entry.kind === 'directory'
        && !visitedDirectories.has(entry.path)
        && visitedEntries < maxEntries
      ) {
        pending.push(entry.path)
      }
    }
  }

  return candidates
    .sort((left, right) => left.score - right.score || left.order - right.order)
    .slice(0, maxResults)
    .map(({ entry }) => entry)
}

function fuzzyPathScore(entry: Entry, query: string): number | null {
  const name = entry.name.toLocaleLowerCase()
  const path = entry.path.toLocaleLowerCase()
  return fuzzyMatchRank(query, {
    primary: [name, path],
    subsequence: [path],
  }, PATH_MATCH_WEIGHTS)
}
