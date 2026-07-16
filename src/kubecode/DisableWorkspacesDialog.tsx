import { useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { createTranslator } from '@/lib/i18n'
import { trackEvent } from '@/lib/telemetry'

import type {
  KubecodeApi,
  Project,
  WorkspaceMigrationPreview,
  WorkspaceMigrationResolution,
  WorkspaceMigrationStrategy,
} from './api'
import { SystemMessageNotice } from './SystemMessageNotice'

type Translator = ReturnType<typeof createTranslator>

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="kubecode-disable-workspaces-dialog">
        <DialogHeader>
          <DialogTitle>{t('kubecode.disableWorkspaces')}</DialogTitle>
          <DialogDescription>{t('kubecode.disableWorkspacesDescription')}</DialogDescription>
        </DialogHeader>
        <div className="kubecode-workspace-migration-list">
          {loading && !preview && <div className="kubecode-empty-small">{t('kubecode.loading')}</div>}
          {active && (
            <SystemMessageNotice
              dismissLabel={t('window.close')}
              level="warning"
              message={t('kubecode.stopSessionsBeforeMigration', {
                count: preview?.active_conversation_ids.length ?? 0,
              })}
            />
          )}
          {preview?.worktrees.map((worktree) => (
            <div className="kubecode-workspace-migration-item" key={worktree.conversation_id}>
              <div>
                <strong>{worktree.title || t('kubecode.untitledSession')}</strong>
                <span>{worktree.dirty ? t('kubecode.uncommittedChanges') : t('kubecode.cleanWorkspace')}</span>
                <code title={worktree.path}>{worktree.path}</code>
              </div>
              <Select
                value={resolutions[worktree.conversation_id] ?? ''}
                onValueChange={(strategy) => setResolutions((current) => ({
                  ...current,
                  [worktree.conversation_id]: strategy as WorkspaceMigrationStrategy,
                }))}
              >
                <SelectTrigger aria-label={t('kubecode.workspaceResolutionFor', { title: worktree.title })}>
                  <SelectValue placeholder={t('kubecode.chooseResolution')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="merge">{t('kubecode.mergeWorkspace')}</SelectItem>
                  <SelectItem value="export_patch">{t('kubecode.exportPatch')}</SelectItem>
                  <SelectItem value="discard">{t('kubecode.discardWorkspace')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ))}
          {preview?.worktrees.length === 0 && !active && (
            <div className="kubecode-empty-small">{t('kubecode.noWorktreesToMigrate')}</div>
          )}
          {error && (
            <SystemMessageNotice
              dismissLabel={t('window.close')}
              level="error"
              message={error}
              onDismiss={() => setError(null)}
            />
          )}
        </div>
        <DialogFooter>
          <DialogClose asChild><Button variant="ghost">{t('kubecode.cancel')}</Button></DialogClose>
          <Button disabled={loading || !preview || active || unresolved} onClick={() => void submit()}>
            {t('kubecode.disableWorkspaces')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}
