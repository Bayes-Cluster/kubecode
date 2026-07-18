import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowClockwise,
  CaretDown,
  Check,
  File,
  FileCode,
  Folder,
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
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { TranslationKey } from '@/lib/i18n'
import { trackEvent } from '@/lib/telemetry'

import { CodeEditor } from './CodeEditor'
import type { SessionPlanEntry } from './AgentSessionWorkspace'
import { ProjectFileTree } from './ProjectFileTree'
import { SystemMessageNotice } from './SystemMessageNotice'
import { useSystemMessages } from './systemMessages'
import type {
  Entry,
  GitFileChange,
  GitStatus,
  KubecodeApi,
  TextDocument,
  WorkspaceEvent,
} from './api'

type Translator = (key: TranslationKey) => string
type ContextTab = 'explorer' | 'editor' | 'diff'
type EntryDialogState = { kind: Entry['kind'] } | null

type ContextWorkbenchProps = {
  api: KubecodeApi
  planEntries?: SessionPlanEntry[]
  planRevealVersion?: number
  projectName?: string
  projectId: string | null
  t: Translator
  width: number
  workspaceEvents: WorkspaceEvent[]
}

export function ContextWorkbench({
  api,
  planEntries = [],
  planRevealVersion = 0,
  projectName,
  projectId,
  t,
  width,
  workspaceEvents,
}: ContextWorkbenchProps) {
  const [tab, setTab] = useState<ContextTab>('explorer')
  const [changesOpen, setChangesOpen] = useState(true)
  const [filesOpen, setFilesOpen] = useState(true)
  const [planSectionState, setPlanSectionState] = useState({
    open: true,
    revealVersion: planRevealVersion,
  })
  const [selectedDirectory, setSelectedDirectory] = useState('')
  const [fileTreeRevision, setFileTreeRevision] = useState(0)
  const [document, setDocument] = useState<TextDocument | null>(null)
  const [draft, setDraft] = useState('')
  const [entryDialog, setEntryDialog] = useState<EntryDialogState>(null)
  const [error, setError] = useState<string | null>(null)
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  const [diff, setDiff] = useState<{ path: string; content: string } | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [discardPath, setDiscardPath] = useState<string | null>(null)
  const systemMessages = useSystemMessages()
  const processedWorkspaceEventRef = useRef(workspaceEvents.at(-1)?.id ?? 0)
  const dirty = Boolean(document && document.content !== draft)
  const reportError = useCallback((cause: unknown) => {
    const message = errorMessage(cause, t('kubecode.error'))
    if (systemMessages) {
      systemMessages.publish({ level: 'error', message, source: t('kubecode.changes') })
    } else {
      setError(message)
    }
  }, [systemMessages, t])

  useEffect(() => {
    if (!projectId) {
      return
    }
    let current = true
    void api.gitStatus(projectId).then((status) => {
      if (current) setGitStatus(status)
    }).catch((cause: unknown) => {
      if (current) reportError(cause)
    })
    return () => { current = false }
  }, [api, projectId, reportError])

  useEffect(() => {
    if (!projectId) return
    const nextEvents = workspaceEvents.filter((event) => (
      event.id > processedWorkspaceEventRef.current && event.project_id === projectId
    ))
    processedWorkspaceEventRef.current = workspaceEvents.at(-1)?.id
      ?? processedWorkspaceEventRef.current
    const filesChanged = nextEvents.some((event) => event.kind === 'file_changed')
    const gitChanged = nextEvents.some((event) => event.kind === 'git_changed')
    if (filesChanged) queueMicrotask(() => setFileTreeRevision((current) => current + 1))
    if (filesChanged || gitChanged) {
      void api.gitStatus(projectId).then(setGitStatus).catch(reportError)
    }
  }, [api, projectId, reportError, workspaceEvents])

  const openEntry = async (entry: Entry) => {
    if (!projectId) return
    setError(null)
    if (entry.kind === 'directory') return
    try {
      const nextDocument = await api.readFile(projectId, entry.path)
      setDocument(nextDocument)
      setDraft(nextDocument.content)
      setTab('editor')
    } catch (cause) {
      reportError(cause)
    }
  }

  const save = async () => {
    if (!projectId || !document || !dirty) return
    try {
      const saved = await api.writeFile(projectId, document.path, draft, document.revision)
      setDocument(saved)
      setDraft(saved.content)
      trackEvent('kubecode_file_saved', { source: 'context_editor' })
    } catch (cause) {
      reportError(cause)
    }
  }

  const closeEditor = () => {
    setDocument(null)
    setDraft('')
    setTab('explorer')
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
      reportError(cause)
    }
  }

  const mutateGit = async (action: 'stage' | 'unstage' | 'discard', path: string) => {
    if (!projectId) return
    try {
      setGitStatus(await api.mutateGit(projectId, action, [path]))
      trackEvent('kubecode_git_action_used', { action })
    } catch (cause) {
      reportError(cause)
    }
  }

  const commit = async () => {
    if (!projectId || !commitMessage.trim()) return
    try {
      setGitStatus(await api.commitGit(projectId, commitMessage))
      setCommitMessage('')
      trackEvent('kubecode_git_action_used', { action: 'commit' })
    } catch (cause) {
      reportError(cause)
    }
  }

  const initializeGit = async () => {
    if (!projectId) return
    try {
      setGitStatus(await api.initializeGit(projectId))
      trackEvent('kubecode_git_action_used', { action: 'init' })
    } catch (cause) {
      reportError(cause)
    }
  }

  const stagedChanges = gitStatus?.files.filter(isStaged) ?? []
  const worktreeChanges = gitStatus?.files.filter(isWorktreeChanged) ?? []

  const editorName = useMemo(() => document?.path.split('/').at(-1), [document])

  const refreshContext = () => {
    setFileTreeRevision((current) => current + 1)
    if (projectId) void api.gitStatus(projectId).then(setGitStatus).catch(reportError)
  }

  return (
    <aside className="kubecode-context-workbench" data-testid="context-workbench" style={{ width }}>
      <Tabs className="kubecode-context-tabs" value={tab} onValueChange={(value) => setTab(value as ContextTab)}>
        <div className="kubecode-context-tabbar">
          <TabsList className="kubecode-context-primary-tabs">
            <TabsTrigger value="explorer">{t('kubecode.explorer')}</TabsTrigger>
            {document && (
              <TabsTrigger value="editor">
                <FileCode /> {editorName}
                {dirty && <span className="kubecode-dirty-dot" />}
              </TabsTrigger>
            )}
            {diff && <TabsTrigger value="diff"><GitDiff /> {diff.path.split('/').at(-1)}</TabsTrigger>}
          </TabsList>
          <div className="kubecode-context-tab-actions">
            {tab === 'explorer' && (
              <>
                <Button aria-label={t('kubecode.newFile')} disabled={!projectId} size="icon-xs" variant="ghost" onClick={() => setEntryDialog({ kind: 'file' })}><File /></Button>
                <Button aria-label={t('kubecode.newFolder')} disabled={!projectId} size="icon-xs" variant="ghost" onClick={() => setEntryDialog({ kind: 'directory' })}><Folder /></Button>
              </>
            )}
            <Button aria-label={t('kubecode.refresh')} size="icon-xs" variant="ghost" onClick={refreshContext}><ArrowClockwise /></Button>
          </div>
        </div>

        <TabsContent className="kubecode-context-content kubecode-context-explorer" value="explorer">
          <ExplorerSection
            count={gitStatus?.files.length}
            expanded={changesOpen}
            label={t('kubecode.changes')}
            onExpandedChange={setChangesOpen}
            section="changes"
          >
            {!gitStatus?.is_repository ? (
              <div className="kubecode-review-empty">
                <GitDiff size={24} />
                <strong>{t('kubecode.createGitRepository')}</strong>
                <span>{t('kubecode.createGitRepositoryDescription')}</span>
                <Button disabled={!projectId} size="sm" onClick={() => void initializeGit()}>{t('kubecode.createGitRepository')}</Button>
              </div>
            ) : gitStatus.files.length === 0 ? (
              <div className="kubecode-review-empty kubecode-review-empty-compact">
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
          </ExplorerSection>
          {planEntries.length > 0 && (
            <ExplorerSection
              count={planEntries.length}
              expanded={
                planSectionState.open
                || planSectionState.revealVersion !== planRevealVersion
              }
              label={t('kubecode.agentPlan')}
              onExpandedChange={(open) => {
                setPlanSectionState({ open, revealVersion: planRevealVersion })
              }}
              section="plan"
            >
              <ol className="kubecode-context-plan-list">
                {planEntries.map((entry, index) => (
                  <li
                    className="kubecode-session-plan-entry"
                    data-priority={entry.priority}
                    data-status={entry.status}
                    key={`${index}-${entry.content}`}
                  >
                    <span className="kubecode-session-plan-state" aria-hidden="true">
                      {entry.status === 'completed' && <Check weight="bold" />}
                    </span>
                    <span>{entry.content}</span>
                  </li>
                ))}
              </ol>
            </ExplorerSection>
          )}
          <ExplorerSection
            expanded={filesOpen}
            fill
            label={t('kubecode.files')}
            onExpandedChange={setFilesOpen}
            section="files"
          >
            {projectId && (
              <ProjectFileTree
                api={api}
                onDirectoryChange={setSelectedDirectory}
                onOpenFile={(entry) => void openEntry(entry)}
                projectId={projectId}
                projectName={projectName ?? projectId}
                refreshVersion={fileTreeRevision}
              />
            )}
          </ExplorerSection>
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
              <Button aria-label={t('kubecode.closeDiff')} size="icon-xs" variant="ghost" onClick={() => { setDiff(null); setTab('explorer') }}><X /></Button>
            </div>
            <pre>{diff.content || t('kubecode.emptyDiff')}</pre>
          </TabsContent>
        )}
      </Tabs>
      {error && (
        <SystemMessageNotice
          dismissLabel={t('window.close')}
          level="error"
          message={error}
          onDismiss={() => setError(null)}
        />
      )}
      <EntryDialog
        api={api}
        directory={selectedDirectory}
        projectId={projectId}
        state={entryDialog}
        onOpenChange={(open) => { if (!open) setEntryDialog(null) }}
        onCreated={() => setFileTreeRevision((current) => current + 1)}
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

function ExplorerSection({
  children,
  count,
  expanded,
  fill = false,
  label,
  onExpandedChange,
  section,
}: {
  children: ReactNode
  count?: number
  expanded: boolean
  fill?: boolean
  label: string
  onExpandedChange: (expanded: boolean) => void
  section: 'changes' | 'files' | 'plan'
}) {
  return (
    <section className="kubecode-explorer-section" data-expanded={expanded} data-fill={fill}>
      <Button
        aria-expanded={expanded}
        className="kubecode-explorer-section-trigger"
        variant="ghost"
        onClick={() => {
          const nextExpanded = !expanded
          onExpandedChange(nextExpanded)
          if (nextExpanded) trackEvent('kubecode_context_section_opened', { section })
        }}
      >
        <CaretDown data-expanded={expanded} />
        <span>{label}</span>
        {typeof count === 'number' && count > 0 && <small>{count}</small>}
      </Button>
      {expanded && <div className="kubecode-explorer-section-content">{children}</div>}
    </section>
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
