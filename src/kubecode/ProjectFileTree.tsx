import { useEffect, useMemo, useState } from 'react'
import { CaretDown, CaretRight } from '@phosphor-icons/react'

import { Button } from '@/components/ui/button'

import type { Entry, KubecodeApi } from './api'
import { ProjectEntryIcon } from './fileIcons'

type ProjectFileTreeProps = {
  api: KubecodeApi
  onDirectoryChange: (path: string) => void
  onOpenFile: (entry: Entry) => void
  projectId: string
  projectName: string
  refreshVersion: number
}

export function ProjectFileTree({
  api,
  onDirectoryChange,
  onOpenFile,
  projectId,
  projectName,
  refreshVersion,
}: ProjectFileTreeProps) {
  const [expanded, setExpanded] = useState(() => new Set(['']))
  const [children, setChildren] = useState(() => new Map<string, Entry[]>())
  const expandedPaths = useMemo(() => [...expanded].sort(), [expanded])

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
    <div aria-label={projectName} className="kubecode-project-file-tree" role="tree">
      <TreeDirectoryRow
        entry={{ kind: 'directory', name: projectName, path: '' }}
        expanded={expanded}
        childrenByPath={children}
        onOpenFile={onOpenFile}
        onToggle={toggleDirectory}
      />
    </div>
  )
}

function TreeDirectoryRow({
  childrenByPath,
  entry,
  expanded,
  onOpenFile,
  onToggle,
}: {
  childrenByPath: Map<string, Entry[]>
  entry: Entry
  expanded: Set<string>
  onOpenFile: (entry: Entry) => void
  onToggle: (path: string) => void
}) {
  const isExpanded = expanded.has(entry.path)
  const children = childrenByPath.get(entry.path) ?? []

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
