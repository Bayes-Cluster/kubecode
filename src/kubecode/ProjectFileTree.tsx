import { useEffect, useMemo, useState } from 'react'
import { CaretDown, CaretRight, Eye, EyeSlash } from '@phosphor-icons/react'

import { Button } from '@/components/ui/button'
import type { TranslationKey } from '@/lib/i18n'

import type { Entry, KubecodeApi } from './api'
import { ProjectEntryIcon } from './fileIcons'
import { isExcludedProjectEntry } from './projectPathSearch'

type ProjectFileTreeProps = {
  api: KubecodeApi
  onDirectoryChange: (path: string) => void
  onOpenFile: (entry: Entry) => void
  projectId: string
  projectName: string
  refreshVersion: number
  t: (key: TranslationKey) => string
}

export function ProjectFileTree({
  api,
  onDirectoryChange,
  onOpenFile,
  projectId,
  projectName,
  refreshVersion,
  t,
}: ProjectFileTreeProps) {
  const [expanded, setExpanded] = useState(() => readExpandedPaths(projectId))
  const [children, setChildren] = useState(() => new Map<string, Entry[]>())
  const [showExcluded, setShowExcluded] = useState(false)
  const expandedPaths = useMemo(() => [...expanded].sort(), [expanded])

  useEffect(() => {
    writeExpandedPaths(projectId, expanded)
  }, [expanded, projectId])

  useEffect(() => {
    let current = true
    void Promise.all(expandedPaths.map(async (path) => (
      [path, await api.listEntries(projectId, path)] as const
    ))).then((loaded) => {
      if (!current) return
      setChildren((existing) => {
        const next = new Map(existing)
        loaded.forEach(([path, entries]) => next.set(path, entries))
        return next
      })
    })
    return () => { current = false }
  }, [api, expandedPaths, projectId, refreshVersion])

  const toggleDirectory = (path: string) => {
    onDirectoryChange(path)
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <div className="kubecode-project-file-browser">
      <div className="kubecode-file-tree-controls">
        <Button
          aria-label={showExcluded
            ? t('kubecode.hideExcludedFiles')
            : t('kubecode.showExcludedFiles')}
          aria-pressed={showExcluded}
          size="icon-xs"
          variant="ghost"
          onClick={() => setShowExcluded((current) => !current)}
        >
          {showExcluded ? <Eye /> : <EyeSlash />}
        </Button>
      </div>
      <div aria-label={projectName} className="kubecode-project-file-tree" role="tree">
        <TreeDirectoryRow
          entry={{ kind: 'directory', name: projectName, path: '' }}
          expanded={expanded}
          childrenByPath={children}
          onOpenFile={onOpenFile}
          onToggle={toggleDirectory}
          showExcluded={showExcluded}
        />
      </div>
    </div>
  )
}

function TreeDirectoryRow({
  childrenByPath,
  entry,
  expanded,
  onOpenFile,
  onToggle,
  showExcluded,
}: {
  childrenByPath: Map<string, Entry[]>
  entry: Entry
  expanded: Set<string>
  onOpenFile: (entry: Entry) => void
  onToggle: (path: string) => void
  showExcluded: boolean
}) {
  const isExpanded = expanded.has(entry.path)
  const children = (childrenByPath.get(entry.path) ?? [])
    .filter((child) => showExcluded || !isExcludedProjectEntry(child))

  return (
    <>
      <Button
        aria-expanded={isExpanded}
        className="kubecode-file-tree-row"
        role="treeitem"
        variant="ghost"
        onClick={() => onToggle(entry.path)}
      >
        {isExpanded ? <CaretDown /> : <CaretRight />}
        <ProjectEntryIcon expanded={isExpanded} kind="directory" name={entry.name} />
        <span>{entry.name}</span>
      </Button>
      {isExpanded && (
        <div role="group">
          {children.map((child) => child.kind === 'directory' ? (
            <TreeDirectoryRow
              childrenByPath={childrenByPath}
              entry={child}
              expanded={expanded}
              key={child.path}
              onOpenFile={onOpenFile}
              onToggle={onToggle}
              showExcluded={showExcluded}
            />
          ) : (
            <Button
              className="kubecode-file-tree-row"
              key={child.path}
              role="treeitem"
              variant="ghost"
              onClick={() => onOpenFile(child)}
            >
              <span className="kubecode-file-tree-spacer" />
              <ProjectEntryIcon kind="file" name={child.name} />
              <span>{child.name}</span>
            </Button>
          ))}
        </div>
      )}
    </>
  )
}

function readExpandedPaths(projectId: string): Set<string> {
  try {
    const stored = globalThis.sessionStorage?.getItem(`kubecode:file-tree:${projectId}`)
    const paths = stored ? JSON.parse(stored) as unknown : null
    if (Array.isArray(paths) && paths.every((path) => typeof path === 'string')) {
      return new Set(['', ...paths])
    }
  } catch {
    // Ignore unavailable or malformed browser storage.
  }
  return new Set([''])
}

function writeExpandedPaths(projectId: string, paths: Set<string>) {
  try {
    globalThis.sessionStorage?.setItem(
      `kubecode:file-tree:${projectId}`,
      JSON.stringify([...paths]),
    )
  } catch {
    // Tree navigation remains usable without browser storage.
  }
}
