import type { Entry, KubecodeApi } from './api'

const EXCLUDED_DIRECTORY_NAMES = new Set([
  '.git',
  '.next',
  '.pytest_cache',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
])

export function isExcludedProjectEntry(entry: Entry): boolean {
  return Boolean(
    entry.hidden
    || entry.ignored
    || (entry.kind === 'directory' && EXCLUDED_DIRECTORY_NAMES.has(entry.name)),
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
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const pending = ['']
  const results: Entry[] = []
  const visitedDirectories = new Set<string>()
  const resultPaths = new Set<string>()
  let visitedEntries = 0

  while (pending.length > 0 && visitedEntries < maxEntries && results.length < maxResults) {
    const directory = pending.shift() as string
    if (visitedDirectories.has(directory)) continue
    visitedDirectories.add(directory)
    const entries = await api.listEntries(projectId, directory)
    visitedEntries += entries.length

    for (const entry of entries) {
      if (!includeExcluded && isExcludedProjectEntry(entry)) continue
      if (
        (!kind || entry.kind === kind)
        && (!normalizedQuery || entry.path.toLocaleLowerCase().includes(normalizedQuery))
        && !resultPaths.has(entry.path)
      ) {
        resultPaths.add(entry.path)
        results.push(entry)
        if (results.length >= maxResults) break
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

  return results
}
