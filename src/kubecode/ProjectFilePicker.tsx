import { Eye, EyeOff } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import type { Translator } from '@/lib/i18n'

import type { Entry, KubecodeApi } from './api'
import { PathPicker, type PathPickerRow } from './PathPicker'
import {
  isExcludedProjectEntry,
  searchProjectEntries,
  searchSessionEntries,
} from './projectPathSearch'

type ProjectFilePickerProps = {
  api: KubecodeApi
  conversationId?: string
  includeDirectories?: boolean
  onEscape?: () => void
  onOpenFile: (entry: Entry) => void
  projectId: string
  recentPaths?: string[]
  refreshVersion?: number
  t: Translator
}

const EMPTY_PATHS: string[] = []

export function ProjectFilePicker({
  api,
  conversationId,
  includeDirectories = false,
  onEscape,
  onOpenFile,
  projectId,
  recentPaths = EMPTY_PATHS,
  refreshVersion = 0,
  t,
}: ProjectFilePickerProps) {
  const [query, setQuery] = useState('')
  const [includeExcluded, setIncludeExcluded] = useState(false)
  const [page, setPage] = useState<{ key: string; results: Entry[] }>({
    key: '',
    results: [],
  })
  const requestIdRef = useRef(0)
  const normalizedQuery = query.trim()
  const searchKey = `${projectId}\u0000${refreshVersion}\u0000${includeExcluded}\u0000${normalizedQuery}`
  const results = useMemo(
    () => page.key === searchKey ? page.results : [],
    [page, searchKey],
  )
  const loading = page.key !== searchKey

  useEffect(() => {
    const requestId = ++requestIdRef.current
    const load = async () => {
      let nextResults: Entry[]
      if (normalizedQuery) {
        nextResults = await (conversationId ? searchSessionEntries({
          api,
          conversationId,
          includeExcluded,
          kind: includeDirectories ? undefined : 'file',
          maxEntries: 2_000,
          maxResults: 100,
          query: normalizedQuery,
        }) : searchProjectEntries({
          api,
          includeExcluded,
          kind: includeDirectories ? undefined : 'file',
          maxEntries: 2_000,
          maxResults: 100,
          projectId,
          query: normalizedQuery,
        }))
      } else {
        const rootEntries = conversationId
          ? await api.listSessionEntries(conversationId, '')
          : await api.listEntries(projectId, '')
        const recentEntries = recentPaths.map((path) => ({
          kind: 'file' as const,
          name: path.split('/').at(-1) ?? path,
          path,
        }))
        nextResults = deduplicateEntries([
          ...recentEntries,
          ...rootEntries.filter((entry) => includeDirectories || entry.kind === 'file'),
        ]).filter((entry) => includeExcluded || !isExcludedProjectEntry(entry)).slice(0, 100)
      }
      if (requestId === requestIdRef.current) {
        setPage({ key: searchKey, results: nextResults })
      }
    }
    const timeout = window.setTimeout(() => {
      void load().catch(() => {
        if (requestId === requestIdRef.current) setPage({ key: searchKey, results: [] })
      })
    }, normalizedQuery ? 120 : 0)
    return () => window.clearTimeout(timeout)
  }, [
    api,
    conversationId,
    includeExcluded,
    includeDirectories,
    normalizedQuery,
    projectId,
    recentPaths,
    refreshVersion,
    searchKey,
  ])

  const rows = useMemo<PathPickerRow[]>(() => results.map((entry) => ({
    id: entry.path,
    kind: entry.kind,
    label: entry.name,
    path: entry.path,
    description: entry.path === entry.name ? undefined : entry.path,
  })), [results])

  return (
    <PathPicker
      ariaLabel={t('kubecode.searchFiles')}
      emptyMessage={t('kubecode.noFilesFound')}
      footer={(
        <div className="kubecode-path-picker-footer">
          <Button
            aria-label={includeExcluded
              ? t('kubecode.hideExcludedFiles')
              : t('kubecode.showExcludedFiles')}
            aria-pressed={includeExcluded}
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => setIncludeExcluded((current) => !current)}
          >
            {includeExcluded ? <Eye  size={16}/> : <EyeOff  size={16}/>}
            {includeExcluded
              ? t('kubecode.hideExcludedFiles')
              : t('kubecode.showExcludedFiles')}
          </Button>
        </div>
      )}
      loading={loading}
      loadingMessage={t('kubecode.loading')}
      onEscape={onEscape}
      onQueryChange={setQuery}
      onSelect={(row) => {
        const entry = results.find((candidate) => candidate.path === row.path)
        if (entry) onOpenFile(entry)
      }}
      placeholder={t('kubecode.searchFiles')}
      query={query}
      rows={rows}
    />
  )
}

function deduplicateEntries(entries: Entry[]): Entry[] {
  const paths = new Set<string>()
  return entries.filter((entry) => {
    if (paths.has(entry.path)) return false
    paths.add(entry.path)
    return true
  })
}
