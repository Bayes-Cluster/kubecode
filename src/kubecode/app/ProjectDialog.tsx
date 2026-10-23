import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowUp, CircleAlert, Eye, EyeOff } from 'lucide-react'
import { trackEvent } from '@/lib/telemetry'

import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Toggle } from '@/components/ui/toggle'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

import type { DirectoryListing, KubecodeApi, Project } from '../api'
import { PathPicker, type PathPickerRow } from '../PathPicker'
import { errorMessage } from './errors'
import type { Translator } from '@/lib/i18n'

export type ProjectDialogProps = {
  api: KubecodeApi
  open: boolean
  onOpenChange: (open: boolean) => void
  onProject: (project: Project) => void
  t: Translator
}

export function ProjectDialog({
  api,
  open,
  onOpenChange,
  onProject,
  t,
}: ProjectDialogProps) {
  const [mode, setMode] = useState<'create' | 'import'>('create')
  const [path, setPath] = useState('')
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [loadingDirectories, setLoadingDirectories] = useState(false)
  const [browserError, setBrowserError] = useState<string | null>(null)

  const browse = useCallback(async (nextPath?: string) => {
    setLoadingDirectories(true)
    setBrowserError(null)
    try {
      const nextListing = await api.listDirectories(nextPath)
      setListing(nextListing)
      return nextListing
    } catch (cause) {
      setBrowserError(errorMessage(cause, t('kubecode.directoryLoadFailed')))
      return null
    } finally {
      setLoadingDirectories(false)
    }
  }, [api, t])

  useEffect(() => {
    if (!open) return
    let current = true
    const timeout = window.setTimeout(() => {
      const split = splitAbsolutePath(path)
      void browse(split?.parent).then((nextListing) => {
        if (!current || path || !nextListing) return
        setPath(withTrailingSlash(nextListing.path))
      })
    }, path ? 120 : 0)
    return () => {
      current = false
      window.clearTimeout(timeout)
    }
  }, [browse, open, path])

  const submit = async () => {
    const targetPath = normalizeAbsolutePath(path)
    if (!targetPath) return
    setBrowserError(null)
    try {
      const project = mode === 'create'
        ? await api.createProject(targetPath)
        : await api.importProject(targetPath)
      trackEvent('kubecode_project_registered', { mode })
      onProject(project)
      setPath('')
      setListing(null)
      onOpenChange(false)
    } catch (cause) {
      setBrowserError(errorMessage(cause, t('kubecode.error')))
    }
  }

  const split = splitAbsolutePath(path)
  const targetPath = normalizeAbsolutePath(path)
  const exactDirectoryExists = Boolean(targetPath && (
    listing?.path === targetPath
    || listing?.entries.some((entry) => entry.path === targetPath)
  ))
  const visibleDirectories = (listing?.entries ?? []).filter((entry) => (
    (showHidden || !entry.hidden)
    && (!split?.filter
      || entry.name.toLocaleLowerCase().includes(split.filter.toLocaleLowerCase()))
  ))
  const actionDisabled = !targetPath
    || (mode === 'create' ? exactDirectoryExists : !exactDirectoryExists)
  const rows = useMemo<PathPickerRow[]>(() => {
    const actionLabel = mode === 'create'
      ? `${t('kubecode.create')} ${targetPath || path}`
      : `${t('kubecode.import')} ${targetPath || path}`
    const nextRows: PathPickerRow[] = path.trim() ? [{
      description: mode === 'create'
        ? exactDirectoryExists
          ? t('kubecode.pathAlreadyExistsImportInstead')
          : t('kubecode.pressEnterToCreate')
        : exactDirectoryExists
          ? t('kubecode.pressEnterToImport')
          : t('kubecode.directoryMustExist'),
      disabled: actionDisabled,
      id: `project-${mode}`,
      kind: 'action',
      label: actionLabel,
      path: targetPath,
    }] : []
    if (listing?.parent) {
      nextRows.push({
        icon: <ArrowUp />,
        id: 'parent-directory',
        kind: 'directory',
        label: '..',
        path: listing.parent,
        description: listing.parent,
      })
    }
    visibleDirectories.forEach((entry) => {
      nextRows.push({
        id: `directory-${entry.path}`,
        kind: 'directory',
        label: entry.name,
        path: entry.path,
        description: entry.path,
      })
    })
    return nextRows
  }, [
    actionDisabled,
    exactDirectoryExists,
    listing?.parent,
    mode,
    path,
    t,
    targetPath,
    visibleDirectories,
  ])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? t('kubecode.createProject') : t('kubecode.importProject')}</DialogTitle>
          <DialogDescription>{t('kubecode.projectPath')}</DialogDescription>
          <p className="text-sm text-muted-foreground">{t('kubecode.projectDialog.next')}</p>
        </DialogHeader>
        <ToggleGroup
          aria-label={t('kubecode.projectPath')}
          className="w-full"
          type="single"
          value={mode}
          variant="outline"
          onValueChange={(next) => {
            if (next === 'create' || next === 'import') setMode(next)
          }}
        >
          <ToggleGroupItem className="flex-1" value="create">{t('kubecode.createProject')}</ToggleGroupItem>
          <ToggleGroupItem className="flex-1" value="import">{t('kubecode.importProject')}</ToggleGroupItem>
        </ToggleGroup>
        <PathPicker
          ariaLabel={t('kubecode.projectPath')}
          className="rounded-md border"
          emptyMessage={t('kubecode.noDirectoriesFound')}
          footer={(
            <div className="flex flex-col gap-2 border-t p-2">
              <Toggle
                className="self-start"
                pressed={showHidden}
                size="sm"
                onPressedChange={setShowHidden}
              >
                {showHidden ? <Eye /> : <EyeOff />}
                {t('kubecode.showHiddenDirectories')}
              </Toggle>
              {browserError && (
                <Alert variant="destructive">
                  <CircleAlert />
                  <AlertDescription>{browserError}</AlertDescription>
                </Alert>
              )}
            </div>
          )}
          loading={loadingDirectories}
          loadingMessage={t('kubecode.loading')}
          onEscape={() => onOpenChange(false)}
          onQueryChange={setPath}
          onSelect={(row) => {
            if (row.id === `project-${mode}`) {
              void submit()
            } else {
              setPath(withTrailingSlash(row.path))
            }
          }}
          placeholder={t('kubecode.absoluteProjectPath')}
          query={path}
          rows={rows}
        />
      </DialogContent>
    </Dialog>
  )
}

function splitAbsolutePath(path: string): { filter: string; parent?: string } | null {
  const trimmed = path.trim()
  if (!trimmed) return { filter: '', parent: undefined }
  if (!trimmed.startsWith('/')) return null
  if (trimmed.endsWith('/')) {
    return { filter: '', parent: normalizeAbsolutePath(trimmed) || '/' }
  }
  const separator = trimmed.lastIndexOf('/')
  return {
    filter: trimmed.slice(separator + 1),
    parent: separator === 0 ? '/' : trimmed.slice(0, separator),
  }
}

function normalizeAbsolutePath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed.startsWith('/')) return ''
  if (trimmed === '/') return '/'
  return trimmed.replace(/\/+$/g, '')
}

function withTrailingSlash(path: string): string {
  return path === '/' ? '/' : `${path.replace(/\/+$/g, '')}/`
}
