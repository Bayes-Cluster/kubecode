import { useCallback, useEffect, useRef, useState } from 'react'
import { CaretDown, CaretRight, Eye, EyeSlash } from '@phosphor-icons/react'

import { Button } from '@/components/ui/button'
import type { Translator } from '@/lib/i18n'

import type { Entry, FileChangedPayload, KubecodeApi } from './api'
import { ProjectEntryIcon } from './fileIcons'
import {
  EMPTY_FILE_TREE_INVALIDATIONS,
  parentDirectoryPath,
  type FileTreeInvalidation,
} from './fileTreeInvalidation'
import { isExcludedProjectEntry } from './projectPathSearch'

type ProjectFileTreeProps = {
  api: KubecodeApi
  invalidations?: FileTreeInvalidation[]
  onDirectoryChange: (path: string) => void
  onOpenFile: (entry: Entry) => void
  projectId: string
  projectName: string
  refreshVersion: number
  t: Translator
}

type DirectoryState = {
  entries: Entry[]
  error: string | null
  generation: number
  loaded: boolean
  loading: boolean
  stale: boolean
}

export function ProjectFileTree({
  api,
  invalidations = EMPTY_FILE_TREE_INVALIDATIONS,
  onDirectoryChange,
  onOpenFile,
  projectId,
  projectName,
  refreshVersion,
  t,
}: ProjectFileTreeProps) {
  const [expanded, setExpanded] = useState(() => readExpandedPaths(projectId))
  const [directories, setDirectories] = useState<Map<string, DirectoryState>>(() => new Map())
  const [showExcluded, setShowExcluded] = useState(false)
  const appliedInvalidationIdRef = useRef(0)
  const expandedRef = useRef(expanded)
  const generationRef = useRef(0)
  const mountedRef = useRef(true)
  const projectIdRef = useRef(projectId)

  useEffect(() => {
    projectIdRef.current = projectId
  }, [projectId])

  useEffect(() => {
    expandedRef.current = expanded
  }, [expanded])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    writeExpandedPaths(projectId, expanded)
  }, [expanded, projectId])

  const requestEntries = useCallback((path: string) => {
    const generation = ++generationRef.current
    const projectIdAtRequest = projectId
    setDirectories((current) => {
      const existing = current.get(path)
      const next = new Map(current)
      next.set(path, {
        entries: existing?.entries ?? [],
        error: null,
        generation,
        loaded: existing?.loaded ?? false,
        loading: true,
        stale: false,
      })
      return next
    })
    void api.listEntries(projectId, path).then(
      (entries) => {
        if (!mountedRef.current || projectIdRef.current !== projectIdAtRequest) return
        setDirectories((current) => {
          const directory = current.get(path)
          if (!directory || directory.generation !== generation) return current
          const next = new Map(current)
          next.set(path, {
            ...directory,
            entries,
            error: null,
            loaded: true,
            loading: false,
            stale: false,
          })
          return next
        })
      },
      (cause: unknown) => {
        if (!mountedRef.current || projectIdRef.current !== projectIdAtRequest) return
        const message = cause instanceof Error ? cause.message : t('kubecode.error')
        setDirectories((current) => {
          const directory = current.get(path)
          if (!directory || directory.generation !== generation) return current
          const next = new Map(current)
          next.set(path, {
            ...directory,
            error: message,
            loaded: true,
            loading: false,
            stale: false,
          })
          return next
        })
      },
    )
  }, [api, projectId, t])

  const reconcileAllStale = useCallback(() => {
    generationRef.current += 1
    const generation = generationRef.current
    setDirectories((current) => {
      if (current.size === 0) return current
      let changed = false
      const next = new Map(current)
      for (const [path, state] of next) {
        next.set(path, { ...state, generation, loading: false, stale: true })
        changed = true
      }
      return changed ? next : current
    })
  }, [])

  const applyScopedInvalidation = useCallback((payload: FileChangedPayload) => {
    const parents = new Set<string>()
    for (const path of payload.paths) {
      parents.add(parentDirectoryPath(path))
    }
    generationRef.current += 1
    const generation = generationRef.current
    setDirectories((current) => {
      const next = new Map(current)
      for (const path of payload.paths) {
        for (const cachedPath of next.keys()) {
          if (cachedPath === path || cachedPath.startsWith(`${path}/`)) {
            next.delete(cachedPath)
          }
        }
      }
      for (const parent of parents) {
        const state = next.get(parent)
        if (state && expandedRef.current.has(parent)) {
          next.set(parent, { ...state, generation, loading: false, stale: state.loaded })
        }
      }
      return next
    })
  }, [])

  useEffect(() => {
    if (invalidations.length === 0) return
    const pending = invalidations.filter(
      (invalidation) => invalidation.id > appliedInvalidationIdRef.current,
    )
    if (pending.length === 0) return
    appliedInvalidationIdRef.current = pending.reduce(
      (highest, invalidation) => Math.max(highest, invalidation.id),
      appliedInvalidationIdRef.current,
    )
    for (const invalidation of pending) {
      if (invalidation.payload.full === true) {
        reconcileAllStale()
      } else if (invalidation.payload.paths.length > 0) {
        applyScopedInvalidation(invalidation.payload)
      }
    }
  }, [applyScopedInvalidation, invalidations, reconcileAllStale])

  useEffect(() => {
    if (refreshVersion === 0) return
    reconcileAllStale()
  }, [reconcileAllStale, refreshVersion])

  useEffect(() => {
    for (const path of expanded) {
      const state = directories.get(path)
      if (state?.loading) continue
      if (!state || !state.loaded || state.stale) {
        requestEntries(path)
      }
    }
  }, [directories, expanded, requestEntries])

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
          directories={directories}
          entry={{ kind: 'directory', name: projectName, path: '' }}
          expanded={expanded}
          onOpenFile={onOpenFile}
          onToggle={toggleDirectory}
          showExcluded={showExcluded}
          t={t}
        />
      </div>
    </div>
  )
}

function TreeDirectoryRow({
  directories,
  entry,
  expanded,
  onOpenFile,
  onToggle,
  showExcluded,
  t,
}: {
  directories: Map<string, DirectoryState>
  entry: Entry
  expanded: Set<string>
  onOpenFile: (entry: Entry) => void
  onToggle: (path: string) => void
  showExcluded: boolean
  t: Translator
}) {
  const isExpanded = expanded.has(entry.path)
  const state = directories.get(entry.path)
  const children = (state?.entries ?? [])
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
          {state?.error && (
            <div className="kubecode-file-tree-empty" role="status">{state.error}</div>
          )}
          {state?.loading && state.entries.length === 0 && (
            <div className="kubecode-file-tree-empty">{t('kubecode.loading')}</div>
          )}
          {children.map((child) => child.kind === 'directory' ? (
            <TreeDirectoryRow
              directories={directories}
              entry={child}
              expanded={expanded}
              key={child.path}
              onOpenFile={onOpenFile}
              onToggle={onToggle}
              showExcluded={showExcluded}
              t={t}
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
