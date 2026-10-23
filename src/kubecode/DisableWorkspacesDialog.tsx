import { useEffect, useId, useMemo, useState } from 'react'

import { CircleAlert, TriangleAlert } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import type { Translator } from '@/lib/i18n'
import { trackEvent } from '@/lib/telemetry'

import type {
  KubecodeApi,
  Project,
  WorkspaceMigrationPreview,
  WorkspaceMigrationResolution,
  WorkspaceMigrationStrategy,
} from './api'

export function DisableWorkspacesDialog({
  api,
  onMigrated,
  onOpenChange,
  open,
  project,
  t,
}: {
  api: KubecodeApi
  onMigrated: (project: Project) => void
  onOpenChange: (open: boolean) => void
  open: boolean
  project: Project
  t: Translator
}) {
  const [preview, setPreview] = useState<WorkspaceMigrationPreview | null>(null)
  const [resolutions, setResolutions] = useState<Record<string, WorkspaceMigrationStrategy>>({})
  const fieldId = useId()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let current = true
    setLoading(true)
    setError(null)
    setPreview(null)
    setResolutions({})
    void api.getWorkspaceMigration(project.id)
      .then((nextPreview) => {
        if (current) setPreview(nextPreview)
      })
      .catch((cause: unknown) => {
        if (current) setError(errorMessage(cause, t('kubecode.workspaceMigrationLoadFailed')))
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    return () => { current = false }
  }, [api, open, project.id, t])

  const migration = useMemo<WorkspaceMigrationResolution[]>(() => (
    preview?.worktrees.flatMap((worktree) => {
      const strategy = resolutions[worktree.conversation_id]
      return strategy ? [{ conversation_id: worktree.conversation_id, strategy }] : []
    }) ?? []
  ), [preview, resolutions])
  const active = (preview?.active_conversation_ids.length ?? 0) > 0
  const unresolved = migration.length !== (preview?.worktrees.length ?? 0)

  const submit = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await api.migrateProjectWorkspaces(project.id, migration)
      trackEvent('kubecode_project_workspaces_disabled', {
        exported: result.exports.length,
        worktrees: migration.length,
      })
      onMigrated(result.project)
      onOpenChange(false)
    } catch (cause) {
      setError(errorMessage(cause, t('kubecode.workspaceMigrationFailed')))
    } finally {
      setLoading(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-xl">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('kubecode.disableWorkspaces')}</AlertDialogTitle>
          <AlertDialogDescription>{t('kubecode.disableWorkspacesDescription')}</AlertDialogDescription>
        </AlertDialogHeader>
        <FieldGroup className="min-h-0 gap-4 overflow-y-auto">
          {loading && !preview && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Spinner aria-hidden="true" />
              {t('kubecode.loading')}
            </p>
          )}
          {active && (
            <Alert>
              <TriangleAlert />
              <AlertDescription>
                {t('kubecode.stopSessionsBeforeMigration', { count: preview?.active_conversation_ids.length ?? 0 })}
              </AlertDescription>
            </Alert>
          )}
          {preview?.worktrees.map((worktree) => {
            const id = `${fieldId}-${worktree.conversation_id}`
            return (
              <Field key={worktree.conversation_id} orientation="responsive">
                <FieldContent className="min-w-0">
                  <FieldLabel htmlFor={id}>{worktree.title || t('kubecode.untitledSession')}</FieldLabel>
                  <FieldDescription>
                    {worktree.dirty ? t('kubecode.uncommittedChanges') : t('kubecode.cleanWorkspace')}
                  </FieldDescription>
                  <code className="truncate text-xs text-muted-foreground" title={worktree.path}>{worktree.path}</code>
                </FieldContent>
                <Select
                  value={resolutions[worktree.conversation_id] ?? ''}
                  onValueChange={(strategy) => setResolutions((current) => ({
                    ...current,
                    [worktree.conversation_id]: strategy as WorkspaceMigrationStrategy,
                  }))}
                >
                  <SelectTrigger
                    aria-label={t('kubecode.workspaceResolutionFor', { title: worktree.title })}
                    className="w-full sm:w-48"
                    id={id}
                  >
                    <SelectValue placeholder={t('kubecode.chooseResolution')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="merge">{t('kubecode.mergeWorkspace')}</SelectItem>
                      <SelectItem value="export_patch">{t('kubecode.exportPatch')}</SelectItem>
                      <SelectItem value="discard">{t('kubecode.discardWorkspace')}</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            )
          })}
          {preview?.worktrees.length === 0 && !active && (
            <Empty className="p-4 md:p-6">
              <EmptyHeader>
                <EmptyDescription>{t('kubecode.noWorktreesToMigrate')}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {error && (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </FieldGroup>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('kubecode.cancel')}</AlertDialogCancel>
          <Button disabled={loading || !preview || active || unresolved} onClick={() => void submit()}>
            {loading && preview && <Spinner aria-hidden="true" data-icon="inline-start" />}
            {t('kubecode.disableWorkspaces')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}
