import type { FileChangedPayload, WorkspaceEvent } from './api'

export const MAX_FILE_CHANGED_PATHS = 256

export type FileTreeInvalidation = {
  id: number
  payload: FileChangedPayload
}

export const EMPTY_FILE_TREE_INVALIDATIONS: FileTreeInvalidation[] = []

/**
 * Aggregates one batch of `file_changed` workspace events into the single
 * canonical payload from ADR 0208. A malformed event, an event combining
 * `full` with paths, or an accumulated path count above the event cap becomes
 * a full invalidation. An event with no usable paths yields an empty scoped
 * event, which consumers ignore.
 */
export function aggregateFileChangedEvents(events: WorkspaceEvent[]): FileChangedPayload {
  const paths = new Set<string>()
  let full = false
  for (const event of events) {
    const { full: eventFull, paths: eventPaths } = event.payload
    if (eventFull === true
      || !Array.isArray(eventPaths)
      || eventPaths.some((path) => typeof path !== 'string')) {
      full = true
    } else {
      for (const path of eventPaths as string[]) {
        if (path.length > 0) paths.add(path)
      }
    }
  }
  if (full || paths.size > MAX_FILE_CHANGED_PATHS) return { paths: [], full: true }
  return { paths: [...paths].sort() }
}

/**
 * Returns the Project-relative directory path that owns an entry, or `''` for
 * the Project root.
 */
export function parentDirectoryPath(path: string): string {
  const separator = path.lastIndexOf('/')
  return separator === -1 ? '' : path.slice(0, separator)
}
