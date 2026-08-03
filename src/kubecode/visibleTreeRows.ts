import type { Entry } from './api'
import { isExcludedProjectEntry } from './projectPathSearch'

export const TREE_VIRTUALIZATION_THRESHOLD = 200

export type CachedDirectoryEntries = {
  entries: readonly Entry[]
}

export type VisibleTreeRow = {
  entry: Entry
  id: string
  depth: number
  isExpanded: boolean
  isFirstSibling: boolean
  isLastSibling: boolean
  kind: Entry['kind']
  name: string
  parentPath: string
  path: string
  siblingCount: number
  siblingIndex: number
}

export type VisibleTreeRowsOptions = {
  directories: ReadonlyMap<string, CachedDirectoryEntries>
  expanded: ReadonlySet<string>
  projectName: string
  showExcluded?: boolean
}

export function deriveVisibleTreeRows({
  directories,
  expanded,
  projectName,
  showExcluded = false,
}: VisibleTreeRowsOptions): VisibleTreeRow[] {
  const rows: VisibleTreeRow[] = []

  const append = (
    entry: Entry,
    parentPath: string,
    depth: number,
    siblingIndex: number,
    siblingCount: number,
  ) => {
    const isExpanded = entry.kind === 'directory' && expanded.has(entry.path)
    rows.push({
      entry,
      id: entry.path,
      depth,
      isExpanded,
      isFirstSibling: siblingIndex === 0,
      isLastSibling: siblingIndex === siblingCount - 1,
      kind: entry.kind,
      name: entry.name,
      parentPath,
      path: entry.path,
      siblingCount,
      siblingIndex,
    })

    if (!isExpanded) return
    const children = (directories.get(entry.path)?.entries ?? [])
      .filter((child) => showExcluded || !isExcludedProjectEntry(child))
    for (const [index, child] of children.entries()) {
      append(child, entry.path, depth + 1, index, children.length)
    }
  }

  const root: Entry = { kind: 'directory', name: projectName, path: '' }
  append(root, '', 0, 0, 1)
  return rows
}
