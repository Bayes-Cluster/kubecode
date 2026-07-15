import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  File,
  FileCode,
  Folder,
  GitBranch,
  GitCommit,
  GitDiff,
  Minus,
  Plus,
  Trash,
  X,
} from '@phosphor-icons/react'

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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { TranslationKey } from '@/lib/i18n'
import { trackEvent } from '@/lib/telemetry'

import { CodeEditor } from './CodeEditor'
import type {
  Entry,
  GitFileChange,
  GitStatus,
  KubecodeApi,
  TextDocument,
  WorkspaceEvent,
} from './api'

type Translator = (key: TranslationKey) => string
type ContextTab = 'review' | 'files' | 'editor' | 'diff'
type EntryDialogState = { kind: Entry['kind'] } | null

type ContextWorkbenchProps = {
  api: KubecodeApi
  projectId: string | null
  t: Translator
  width: number
  workspaceEvent: WorkspaceEvent | null
}

export function ContextWorkbench({ api, projectId, t, width, workspaceEvent }: ContextWorkbenchProps) {
  const [tab, setTab] = useState<ContextTab>('review')
  const [entries, setEntries] = useState<Entry[]>([])
  const [directory, setDirectory] = useState('')
  const [document, setDocument] = useState<TextDocument | null>(null)
  const [draft, setDraft] = useState('')
  const [entryDialog, setEntryDialog] = useState<EntryDialogState>(null)
  const [error, setError] = useState<string | null>(null)
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  const [diff, setDiff] = useState<{ path: string; content: string } | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [discardPath, setDiscardPath] = useState<string | null>(null)
  const dirty = Boolean(document && document.content !== draft)

  const refreshEntries = useCallback(async (path = directory) => {
    if (projectId) setEntries(await api.listEntries(projectId, path))
  }, [api, directory, projectId])

  useEffect(() => {
    if (!projectId) {
      return
    }
    let current = true
    void Promise.all([api.listEntries(projectId), api.gitStatus(projectId)]).then(([nextEntries, status]) => {
      if (current) {
        setEntries(nextEntries)
        setGitStatus(status)
      }
    }).catch((cause: unknown) => {
      if (current) setError(errorMessage(cause, t('kubecode.error')))
    })
    return () => { current = false }
  }, [api, projectId, t])

  useEffect(() => {
    if (!projectId || workspaceEvent?.project_id !== projectId) return
    if (workspaceEvent.kind === 'file_changed') queueMicrotask(() => void refreshEntries())
    if (workspaceEvent.kind === 'file_changed' || workspaceEvent.kind === 'git_changed') {
      void api.gitStatus(projectId).then(setGitStatus)
    }
  }, [api, projectId, refreshEntries, workspaceEvent])

  const openEntry = async (entry: Entry) => {
    if (!projectId) return
    setError(null)
    if (entry.kind === 'directory') {
      setDirectory(entry.path)
      await refreshEntries(entry.path)
      return
    }
    const nextDocument = await api.readFile(projectId, entry.path)
    setDocument(nextDocument)
    setDraft(nextDocument.content)
    setTab('editor')
  }

  const goBack = async () => {
    const parent = directory.includes('/') ? directory.slice(0, directory.lastIndexOf('/')) : ''
    setDirectory(parent)
    await refreshEntries(parent)
  }

  const save = async () => {
    if (!projectId || !document || !dirty) return
    try {
      const saved = await api.writeFile(projectId, document.path, draft, document.revision)
      setDocument(saved)
      setDraft(saved.content)
      trackEvent('kubecode_file_saved', { source: 'context_editor' })
    } catch (cause) {
      setError(errorMessage(cause, t('kubecode.error')))
    }
  }

  const closeEditor = () => {
    setDocument(null)
    setDraft('')
    setTab('review')
  }

  const openDiff = async (change: GitFileChange, staged: boolean) => {
    if (!projectId) return
    try {
      const content = change.index_status === '?' && change.worktree_status === '?'
        ? (await api.readFile(projectId, change.path)).content
            .split('\n').map((line) => `+${line}`).join('\n')
        : await api.gitDiff(projectId, change.path, staged)
      setDiff({ path: change.path, content })
      setTab('diff')
    } catch (cause) {
      setError(errorMessage(cause, t('kubecode.error')))
    }
  }

  const mutateGit = async (action: 'stage' | 'unstage' | 'discard', path: string) => {
    if (!projectId) return
    try {
      setGitStatus(await api.mutateGit(projectId, action, [path]))
      trackEvent('kubecode_git_action_used', { action })
    } catch (cause) {
      setError(errorMessage(cause, t('kubecode.error')))
    }
  }

  const commit = async () => {
    if (!projectId || !commitMessage.trim()) return
    try {
      setGitStatus(await api.commitGit(projectId, commitMessage))
      setCommitMessage('')
      trackEvent('kubecode_git_action_used', { action: 'commit' })
    } catch (cause) {
      setError(errorMessage(cause, t('kubecode.error')))
    }
  }

  const initializeGit = async () => {
    if (!projectId) return
    try {
      setGitStatus(await api.initializeGit(projectId))
      trackEvent('kubecode_git_action_used', { action: 'init' })
    } catch (cause) {
      setError(errorMessage(cause, t('kubecode.error')))
    }
  }

  const stagedChanges = gitStatus?.files.filter(isStaged) ?? []
  const worktreeChanges = gitStatus?.files.filter(isWorktreeChanged) ?? []

  const editorName = useMemo(() => document?.path.split('/').at(-1), [document])

  return (
    <aside className="kubecode-context-workbench" data-testid="context-workbench" style={{ width }}>
      <Tabs className="kubecode-context-tabs" value={tab} onValueChange={(value) => setTab(value as ContextTab)}>
        <div className="kubecode-context-tabbar">
          <TabsList className="h-full gap-0 p-0" variant="line">
            <TabsTrigger value="review"><GitDiff /> {t('kubecode.review')}</TabsTrigger>
            <TabsTrigger value="files"><Folder /> {t('kubecode.files')}</TabsTrigger>
            {document && (
              <TabsTrigger value="editor">
                <FileCode /> {editorName}
                {dirty && <span className="kubecode-dirty-dot" />}
              </TabsTrigger>
            )}
            {diff && <TabsTrigger value="diff"><GitDiff /> {diff.path.split('/').at(-1)}</TabsTrigger>}
          </TabsList>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button aria-label={t('kubecode.openContext')} size="icon-xs" variant="ghost"><Plus /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setTab('review')}><GitDiff /> {t('kubecode.review')}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setTab('files')}><Folder /> {t('kubecode.files')}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <TabsContent className="kubecode-context-content" value="review">
          <div className="kubecode-review-toolbar">
            <strong>{t('kubecode.changes')}</strong>
            {gitStatus?.branch && <span><GitBranch /> {gitStatus.branch}</span>}
          </div>
          {!gitStatus?.is_repository ? (
            <div className="kubecode-review-empty">
              <GitDiff size={30} />
              <strong>{t('kubecode.createGitRepository')}</strong>
              <span>{t('kubecode.createGitRepositoryDescription')}</span>
              <Button disabled={!projectId} onClick={() => void initializeGit()}>{t('kubecode.createGitRepository')}</Button>
            </div>
          ) : gitStatus.files.length === 0 ? (
            <div className="kubecode-review-empty">
              <GitDiff size={30} />
              <strong>{t('kubecode.noChanges')}</strong>
              <span>{t('kubecode.reviewDescription')}</span>
            </div>
          ) : (
            <div className="kubecode-review-body">
              {stagedChanges.length > 0 && (
                <GitChangeGroup
                  changes={stagedChanges}
                  label={t('kubecode.stagedChanges')}
                  onDiff={(change) => void openDiff(change, true)}
                  onPrimary={(change) => void mutateGit('unstage', change.path)}
                  primaryLabel={t('kubecode.unstage')}
                  primaryIcon={<Minus />}
                />
              )}
              {worktreeChanges.length > 0 && (
                <GitChangeGroup
                  changes={worktreeChanges}
                  label={t('kubecode.changes')}
                  onDiff={(change) => void openDiff(change, false)}
                  onDiscard={(change) => setDiscardPath(change.path)}
                  onPrimary={(change) => void mutateGit('stage', change.path)}
                  primaryLabel={t('kubecode.stage')}
                  primaryIcon={<Plus />}
                  discardLabel={t('kubecode.discard')}
                />
              )}
              {stagedChanges.length > 0 && (
                <div className="kubecode-commit-box">
                  <Input aria-label={t('kubecode.commitMessage')} placeholder={t('kubecode.commitMessage')} value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} />
                  <Button disabled={!commitMessage.trim()} size="sm" onClick={() => void commit()}><GitCommit /> {t('kubecode.commit')}</Button>
                </div>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent className="kubecode-context-content" value="files">
          <div className="kubecode-files-toolbar">
            <div className="kubecode-path-label">{directory || projectId || t('kubecode.files')}</div>
            <div>
              <Button aria-label={t('kubecode.newFile')} disabled={!projectId} size="icon-xs" variant="ghost" onClick={() => setEntryDialog({ kind: 'file' })}>
                <File />
              </Button>
              <Button aria-label={t('kubecode.newFolder')} disabled={!projectId} size="icon-xs" variant="ghost" onClick={() => setEntryDialog({ kind: 'directory' })}>
                <Folder />
              </Button>
            </div>
          </div>
          {directory && (
            <Button className="kubecode-file-row" variant="ghost" onClick={() => void goBack()}>
              <ArrowLeft /> {t('kubecode.back')}
            </Button>
          )}
          <div className="kubecode-context-file-list">
            {entries.map((entry) => (
              <Button className="kubecode-file-row" key={entry.path} variant="ghost" onClick={() => void openEntry(entry)}>
                {entry.kind === 'directory' ? <Folder /> : <File />}
                <span>{entry.name}</span>
              </Button>
            ))}
            {projectId && entries.length === 0 && <div className="kubecode-empty-small">{t('kubecode.emptyDirectory')}</div>}
          </div>
        </TabsContent>

        {document && (
          <TabsContent className="kubecode-context-content kubecode-context-editor" value="editor">
            <div className="kubecode-editor-toolbar">
              <span title={document.path}>{document.path}</span>
              <div>
                {dirty && <span className="kubecode-unsaved-label">{t('kubecode.unsaved')}</span>}
                <Button disabled={!dirty} size="xs" onClick={() => void save()}>{t('kubecode.save')}</Button>
                <Button aria-label={t('kubecode.closeEditor')} size="icon-xs" variant="ghost" onClick={closeEditor}><X /></Button>
              </div>
            </div>
            <CodeEditor content={document.content} documentKey={`${document.path}:${document.revision}`} onChange={setDraft} />
          </TabsContent>
        )}
        {diff && (
          <TabsContent className="kubecode-context-content kubecode-diff-view" value="diff">
            <div className="kubecode-editor-toolbar">
              <span>{diff.path}</span>
              <Button aria-label={t('kubecode.closeDiff')} size="icon-xs" variant="ghost" onClick={() => { setDiff(null); setTab('review') }}><X /></Button>
            </div>
            <pre>{diff.content || t('kubecode.emptyDiff')}</pre>
          </TabsContent>
        )}
      </Tabs>
      {error && <div className="kubecode-inline-error">{error}</div>}
      <EntryDialog
        api={api}
        directory={directory}
        projectId={projectId}
        state={entryDialog}
        onOpenChange={(open) => { if (!open) setEntryDialog(null) }}
        onCreated={() => void refreshEntries()}
        t={t}
      />
      <Dialog open={Boolean(discardPath)} onOpenChange={(open) => { if (!open) setDiscardPath(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('kubecode.discardChanges')}</DialogTitle>
            <DialogDescription>{t('kubecode.discardChangesDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">{t('kubecode.cancel')}</Button></DialogClose>
            <Button variant="destructive" onClick={() => {
              if (discardPath) void mutateGit('discard', discardPath)
              setDiscardPath(null)
            }}><Trash /> {t('kubecode.discard')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  )
}

function GitChangeGroup({
  changes,
  label,
  onDiff,
  onDiscard,
  onPrimary,
  primaryIcon,
  primaryLabel,
  discardLabel,
}: {
  changes: GitFileChange[]
  label: string
  onDiff: (change: GitFileChange) => void
  onDiscard?: (change: GitFileChange) => void
  onPrimary: (change: GitFileChange) => void
  primaryIcon: ReactNode
  primaryLabel: string
  discardLabel?: string
}) {
  return (
    <section className="kubecode-git-group">
      <header><strong>{label}</strong><span>{changes.length}</span></header>
      {changes.map((change) => (
        <div className="kubecode-git-row" key={`${label}:${change.path}`}>
          <Button className="kubecode-git-path" variant="ghost" onClick={() => onDiff(change)}>
            <span>{change.path}</span>
            <code>{change.worktree_status ?? change.index_status}</code>
          </Button>
          {onDiscard && (
            <Button aria-label={`${discardLabel}: ${change.path}`} size="icon-xs" variant="ghost" onClick={() => onDiscard(change)}><Trash /></Button>
          )}
          <Button aria-label={`${primaryLabel}: ${change.path}`} size="icon-xs" variant="ghost" onClick={() => onPrimary(change)}>{primaryIcon}</Button>
        </div>
      ))}
    </section>
  )
}

function isStaged(change: GitFileChange): boolean {
  return Boolean(change.index_status && change.index_status !== '?')
}

function isWorktreeChanged(change: GitFileChange): boolean {
  return Boolean(change.worktree_status || change.index_status === '?')
}

function EntryDialog({
  api,
  directory,
  projectId,
  state,
  onOpenChange,
  onCreated,
  t,
}: {
  api: KubecodeApi
  directory: string
  projectId: string | null
  state: EntryDialogState
  onOpenChange: (open: boolean) => void
  onCreated: () => void
  t: Translator
}) {
  const [path, setPath] = useState('')
  const create = async () => {
    if (!projectId || !state) return
    const relativePath = [directory, path.trim()].filter(Boolean).join('/')
    await api.createEntry(projectId, relativePath, state.kind)
    setPath('')
    onOpenChange(false)
    onCreated()
  }
  return (
    <Dialog open={Boolean(state)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{state?.kind === 'directory' ? t('kubecode.newFolder') : t('kubecode.newFile')}</DialogTitle>
          <DialogDescription>{t('kubecode.entryPath')}</DialogDescription>
        </DialogHeader>
        <Input aria-label={t('kubecode.entryPath')} value={path} onChange={(event) => setPath(event.target.value)} />
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">{t('kubecode.cancel')}</Button></DialogClose>
          <Button disabled={!path.trim()} onClick={() => void create()}>{t('kubecode.create')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}
