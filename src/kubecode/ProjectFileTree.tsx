import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
} from 'react'
import { CaretDown, CaretRight, Eye, EyeSlash } from '@phosphor-icons/react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'

import { Button } from '@/components/ui/button'
import type { Translator } from '@/lib/i18n'

import type { Entry, FileChangedPayload, KubecodeApi } from './api'
import { MaterialDirectoryIcon } from './icons/material/materialIcons'
import { MaterialFileIcon } from './icons/material/materialIcons'
import { resolveFileIcon } from './icons/resolveFileIcon'
import {
  EMPTY_FILE_TREE_INVALIDATIONS,
  parentDirectoryPath,
  type FileTreeInvalidation,
} from './fileTreeInvalidation'
import {
  deriveVisibleTreeRows,
  TREE_VIRTUALIZATION_THRESHOLD,
  type VisibleTreeRow,
} from './visibleTreeRows'

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
  const [activePath, setActivePath] = useState('')
  const [selectedPath, setSelectedPath] = useState('')
  const appliedInvalidationIdRef = useRef(0)
  const expandedRef = useRef(expanded)
  const generationRef = useRef(0)
  const mountedRef = useRef(true)
  const projectIdRef = useRef(projectId)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const focusActiveRowRef = useRef(false)

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
        stale: existing?.stale ?? false,
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
            stale: true,
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
        next.set(path, { ...state, error: null, generation, loading: false, stale: true })
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
          next.set(parent, {
            ...state,
            error: null,
            generation,
            loading: false,
            stale: state.loaded,
          })
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
      if (!state || !state.loaded || (state.stale && !state.error)) {
        requestEntries(path)
      }
    }
  }, [directories, expanded, requestEntries])

  const rows = useMemo(() => deriveVisibleTreeRows({
    directories,
    expanded,
    projectName,
    showExcluded,
  }), [directories, expanded, projectName, showExcluded])
  const isVirtualized = rows.length > TREE_VIRTUALIZATION_THRESHOLD
  const expandedErrors = [...expanded]
    .map((path) => directories.get(path)?.error)
    .filter((message): message is string => Boolean(message))
  const isLoading = [...expanded].some((path) => directories.get(path)?.loading)
  const hasStaleData = [...directories.values()].some((state) => state.stale)

  const visibleActivePath = rows.some((row) => row.path === activePath)
    ? activePath
    : rows[0]?.path ?? ''
  const visibleSelectedPath = rows.some((row) => row.path === selectedPath)
    ? selectedPath
    : rows[0]?.path ?? ''

  const focusMountedActiveRow = useCallback(() => {
    if (!focusActiveRowRef.current) return
    const row = rowRefs.current.get(visibleActivePath)
    if (!row) return
    focusActiveRowRef.current = false
    row.focus()
  }, [visibleActivePath])

  useEffect(() => {
    if (!focusActiveRowRef.current) return
    focusMountedActiveRow()
    if (!focusActiveRowRef.current) return
    const index = rows.findIndex((candidate) => candidate.path === visibleActivePath)
    if (index < 0 || !isVirtualized) return
    virtuosoRef.current?.scrollIntoView({
      align: 'center',
      behavior: 'auto',
      done: focusMountedActiveRow,
      index,
    })
    const frame = window.requestAnimationFrame(() => {
      focusMountedActiveRow()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [focusMountedActiveRow, isVirtualized, rows, visibleActivePath])

  const setActiveRow = useCallback((path: string, focus = false) => {
    focusActiveRowRef.current = focus
    setActivePath(path)
    setSelectedPath(path)
  }, [])

  const toggleDirectory = useCallback((path: string) => {
    onDirectoryChange(path)
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [onDirectoryChange])

  const activateRow = useCallback((row: VisibleTreeRow) => {
    setActiveRow(row.path)
    if (row.kind === 'directory') toggleDirectory(row.path)
    else onOpenFile(row.entry)
  }, [onOpenFile, setActiveRow, toggleDirectory])

  const moveActiveRow = useCallback((index: number) => {
    const next = rows[index]
    if (next) setActiveRow(next.path, true)
  }, [rows, setActiveRow])

  const handleTreeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    const targetPath = target.closest<HTMLElement>('[data-tree-row-path]')
      ?.dataset.treeRowPath
    const rowIndex = Math.max(0, rows.findIndex((row) => row.path === (targetPath ?? visibleActivePath)))
    const row = rows[rowIndex]
    if (!row) return

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveActiveRow(Math.max(0, Math.min(
        rows.length - 1,
        rowIndex + (event.key === 'ArrowDown' ? 1 : -1),
      )))
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      moveActiveRow(event.key === 'Home' ? 0 : rows.length - 1)
      return
    }
    if (event.key === 'ArrowRight' && row.kind === 'directory') {
      event.preventDefault()
      if (!row.isExpanded) toggleDirectory(row.path)
      else if (rows[rowIndex + 1]?.parentPath === row.path) moveActiveRow(rowIndex + 1)
      return
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      if (row.kind === 'directory' && row.isExpanded) toggleDirectory(row.path)
      else if (row.parentPath !== row.path) setActiveRow(row.parentPath, true)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      activateRow(row)
    }
  }, [activateRow, moveActiveRow, rows, setActiveRow, toggleDirectory, visibleActivePath])

  const renderRow = useCallback((_index: number, row: VisibleTreeRow) => (
    <TreeRow
      active={visibleActivePath === row.path}
      key={row.id}
      onActivate={activateRow}
      onRegister={(element) => {
        if (element) rowRefs.current.set(row.path, element)
        else rowRefs.current.delete(row.path)
      }}
      row={row}
      selected={visibleSelectedPath === row.path}
    />
  ), [activateRow, visibleActivePath, visibleSelectedPath])

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
      <div
        aria-busy={isLoading || undefined}
        aria-label={projectName}
        className="kubecode-project-file-tree"
        data-active-path={visibleActivePath}
        data-selected-path={visibleSelectedPath}
        data-stale={hasStaleData || undefined}
        data-virtualized={isVirtualized || undefined}
        role="tree"
        tabIndex={-1}
        onKeyDown={handleTreeKeyDown}
      >
        {isVirtualized ? (
          <Virtuoso
            ref={virtuosoRef}
            className="kubecode-file-tree-virtual-list"
            computeItemKey={(_index, row) => row.id}
            data={rows}
            defaultItemHeight={26}
            fixedItemHeight={26}
            increaseViewportBy={{ bottom: 260, top: 260 }}
            itemContent={renderRow}
            itemsRendered={focusMountedActiveRow}
            components={{ Scroller: TreeVirtuosoScroller }}
          />
        ) : rows.map((row, index) => renderRow(index, row))}
      </div>
      {isLoading && <div className="kubecode-file-tree-empty">{t('kubecode.loading')}</div>}
      {expandedErrors.map((message) => (
        <div className="kubecode-file-tree-empty" key={message} role="status">{message}</div>
      ))}
    </div>
  )
}

function TreeRow({
  active,
  onActivate,
  onRegister,
  row,
  selected,
}: {
  active: boolean
  onActivate: (row: VisibleTreeRow) => void
  onRegister: (element: HTMLButtonElement | null) => void
  row: VisibleTreeRow
  selected: boolean
}) {
  return (
    <Button
      ref={onRegister}
      aria-expanded={row.kind === 'directory' ? row.isExpanded : undefined}
      aria-level={row.depth + 1}
      aria-posinset={row.siblingIndex + 1}
      aria-selected={selected}
      aria-setsize={row.siblingCount}
      className="kubecode-file-tree-row"
      data-active={active || undefined}
      data-tree-row-path={row.path}
      id={treeRowId(row.path)}
      role="treeitem"
      style={{ paddingLeft: `${7 + row.depth * 13}px` }}
      tabIndex={active ? 0 : -1}
      variant="ghost"
      onClick={() => onActivate(row)}
    >
      {row.kind === 'directory' && (row.isExpanded ? <CaretDown /> : <CaretRight />)}
      {row.kind === 'file' && <span className="kubecode-file-tree-spacer" />}
      {row.kind === 'directory'
        ? <MaterialDirectoryIcon expanded={row.isExpanded} name={row.name} />
        : <MaterialFileIcon id={resolveFileIcon(row.name)} />}
      <span>{row.name}</span>
    </Button>
  )
}

function treeRowId(path: string): string {
  return `kubecode-tree-row-${encodeURIComponent(path || 'root')}`
}

const TreeVirtuosoScroller = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function TreeVirtuosoScroller(props, ref) {
    return <div {...props} ref={ref} tabIndex={-1} />
  },
)

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
