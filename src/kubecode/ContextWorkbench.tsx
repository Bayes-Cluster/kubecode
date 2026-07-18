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
  MagnifyingGlass,
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
import { PathPicker, type PathPickerRow } from './PathPicker'
import { ProjectFilePicker } from './ProjectFilePicker'
import { ProjectFileTree } from './ProjectFileTree'
import { searchProjectEntries } from './projectPathSearch'
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
type EntryDialogState = { kind: Entry['kind'] } | null
type OpenDocument = {
  document: TextDocument
  draft: string
  projectId: string
}

type ContextWorkbenchProps = {
  api: KubecodeApi
  autoSave?: boolean
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
  autoSave = false,
  planEntries = [],
  planRevealVersion = 0,
  projectName,
  projectId,
  t,
  width,
  workspaceEvents,
}: ContextWorkbenchProps) {
  const [tab, setTab] = useState('explorer')
  const [changesOpen, setChangesOpen] = useState(true)
  const [filesOpen, setFilesOpen] = useState(true)
  const [planSectionState, setPlanSectionState] = useState({
    open: true,
    revealVersion: planRevealVersion,
  })
  const [selectedDirectory, setSelectedDirectory] = useState('')
  const [fileTreeRevision, setFileTreeRevision] = useState(0)
  const [documents, setDocuments] = useState<OpenDocument[]>([])
  const [activeDocumentKey, setActiveDocumentKey] = useState<string | null>(null)
  const [closeDocumentKey, setCloseDocumentKey] = useState<string | null>(null)
  const [entryDialog, setEntryDialog] = useState<EntryDialogState>(null)
  const [quickOpen, setQuickOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  const [diff, setDiff] = useState<{ path: string; content: string } | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [discardPath, setDiscardPath] = useState<string | null>(null)
  const systemMessages = useSystemMessages()
  const processedWorkspaceEventRef = useRef(workspaceEvents.at(-1)?.id ?? 0)
  const savingDocumentsRef = useRef(new Set<string>())
  const projectDocuments = useMemo(
    () => documents.filter((item) => item.projectId === projectId),
    [documents, projectId],
  )
  const activeDocument = documents.find(
    (item) => documentKey(item.projectId, item.document.path) === activeDocumentKey,
  ) ?? null
  const dirty = Boolean(
    activeDocument && activeDocument.document.content !== activeDocument.draft,
  )
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
    setTab('explorer')
    setActiveDocumentKey(null)
    setDiff(null)
    setSelectedDirectory('')
  }, [projectId])

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

  useEffect(() => {
    const openQuickFile = (event: KeyboardEvent) => {
      if (!projectId || event.defaultPrevented) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'p') {
        event.preventDefault()
        setQuickOpen(true)
      }
    }
    document.addEventListener('keydown', openQuickFile)
    return () => document.removeEventListener('keydown', openQuickFile)
  }, [projectId])

  const openEntry = async (entry: Entry) => {
    if (!projectId) return
    setError(null)
    if (entry.kind === 'directory') return
    const key = documentKey(projectId, entry.path)
    if (documents.some((item) => documentKey(item.projectId, item.document.path) === key)) {
      setActiveDocumentKey(key)
      setTab(`editor:${key}`)
      return
    }
    try {
      const nextDocument = await api.readFile(projectId, entry.path)
      setDocuments((current) => [
        ...current,
        { document: nextDocument, draft: nextDocument.content, projectId },
      ])
      setActiveDocumentKey(key)
      setTab(`editor:${key}`)
    } catch (cause) {
      reportError(cause)
    }
  }

  const saveDocument = useCallback(async (key: string) => {
    const target = documents.find(
      (item) => documentKey(item.projectId, item.document.path) === key,
    )
    if (!target || target.document.content === target.draft) return
    if (savingDocumentsRef.current.has(key)) return
    savingDocumentsRef.current.add(key)
    try {
      const saved = await api.writeFile(
        target.projectId,
        target.document.path,
        target.draft,
        target.document.revision,
      )
      setDocuments((current) => current.map((item) => (
        documentKey(item.projectId, item.document.path) === key
          ? {
              ...item,
              document: saved,
              draft: item.draft === target.draft ? saved.content : item.draft,
            }
          : item
      )))
      trackEvent('kubecode_file_saved', { source: 'context_editor' })
    } catch (cause) {
      reportError(cause)
    } finally {
      savingDocumentsRef.current.delete(key)
    }
  }, [api, documents, reportError])

  const save = async () => {
    if (!activeDocumentKey) return
    await saveDocument(activeDocumentKey)
  }

  useEffect(() => {
    if (!autoSave) return
    const timers = documents
      .filter((item) => item.document.content !== item.draft)
      .map((item) => window.setTimeout(
        () => void saveDocument(documentKey(item.projectId, item.document.path)),
        1000,
      ))
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [autoSave, documents, saveDocument])

  const closeEditor = (key: string, force = false) => {
    const target = documents.find(
      (item) => documentKey(item.projectId, item.document.path) === key,
    )
    if (!force && target && target.document.content !== target.draft) {
      setCloseDocumentKey(key)
      return
    }
    setDocuments((current) => current.filter(
      (item) => documentKey(item.projectId, item.document.path) !== key,
    ))
    if (activeDocumentKey === key) {
      const remaining = projectDocuments.filter(
        (item) => documentKey(item.projectId, item.document.path) !== key,
      )
      const next = remaining.at(-1)
      setActiveDocumentKey(next ? documentKey(next.projectId, next.document.path) : null)
      setTab(next ? `editor:${documentKey(next.projectId, next.document.path)}` : 'explorer')
    }
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

  const refreshContext = () => {
    setFileTreeRevision((current) => current + 1)
    if (projectId) void api.gitStatus(projectId).then(setGitStatus).catch(reportError)
  }

  return (
    <aside className="kubecode-context-workbench" data-testid="context-workbench" style={{ width }}>
      <Tabs
        className="kubecode-context-tabs"
        value={tab}
        onValueChange={(value) => {
          if (value.startsWith('editor:')) setActiveDocumentKey(value.slice('editor:'.length))
          setTab(value)
        }}
      >
        <div className="kubecode-context-tabbar">
          <TabsList className="kubecode-context-primary-tabs">
            <TabsTrigger value="explorer" onClick={() => setTab('explorer')}>
              {t('kubecode.explorer')}
            </TabsTrigger>
            {projectDocuments.map((item) => {
              const key = documentKey(item.projectId, item.document.path)
              const itemDirty = item.document.content !== item.draft
              return (
                <TabsTrigger
                  data-active-document={activeDocumentKey === key}
                  key={key}
                  value={`editor:${key}`}
                  onClick={() => {
                    setActiveDocumentKey(key)
                    setTab(`editor:${key}`)
                  }}
                >
                  <FileCode /> {item.document.path.split('/').at(-1)}
                  {itemDirty && <span className="kubecode-dirty-dot" />}
                </TabsTrigger>
              )
            })}
            {diff && (
              <TabsTrigger value="diff" onClick={() => setTab('diff')}>
                <GitDiff /> {diff.path.split('/').at(-1)}
              </TabsTrigger>
            )}
          </TabsList>
          <div className="kubecode-context-tab-actions">
            {tab === 'explorer' && (
              <>
                <Button aria-label={t('kubecode.searchFiles')} disabled={!projectId} size="icon-xs" variant="ghost" onClick={() => setQuickOpen(true)}><MagnifyingGlass /></Button>
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
                key={projectId}
                onDirectoryChange={setSelectedDirectory}
                onOpenFile={(entry) => void openEntry(entry)}
                projectId={projectId}
                projectName={projectName ?? projectId}
                refreshVersion={fileTreeRevision}
                t={t}
              />
            )}
          </ExplorerSection>
        </TabsContent>

        {activeDocument && (
          <TabsContent
            className="kubecode-context-content kubecode-context-editor"
            value={`editor:${activeDocumentKey}`}
          >
            <div className="kubecode-editor-toolbar">
              <span title={activeDocument.document.path}>{activeDocument.document.path}</span>
              <div>
                {dirty && <span className="kubecode-unsaved-label">{t('kubecode.unsaved')}</span>}
                <Button disabled={!dirty} size="xs" onClick={() => void save()}>{t('kubecode.save')}</Button>
                <Button
                  aria-label={t('kubecode.closeEditor')}
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => closeEditor(activeDocumentKey as string)}
                >
                  <X />
                </Button>
              </div>
            </div>
            <CodeEditor
              content={activeDocument.draft}
              documentKey={`${activeDocument.document.path}:${activeDocument.document.revision}`}
              onChange={(draft) => setDocuments((current) => current.map((item) => (
                documentKey(item.projectId, item.document.path) === activeDocumentKey
                  ? { ...item, draft }
                  : item
              )))}
            />
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
        key={`${projectId}:${entryDialog?.kind ?? 'closed'}:${selectedDirectory}`}
        projectId={projectId}
        state={entryDialog}
        onOpenChange={(open) => { if (!open) setEntryDialog(null) }}
        onCreated={(entry) => {
          setFileTreeRevision((current) => current + 1)
          if (entry.kind === 'file') void openEntry(entry)
        }}
        t={t}
      />
      <Dialog open={quickOpen} onOpenChange={setQuickOpen}>
        <DialogContent
          aria-label={t('kubecode.searchFiles')}
          className="kubecode-path-picker-dialog"
          showCloseButton={false}
        >
          <DialogHeader className="sr-only">
            <DialogTitle>{t('kubecode.searchFiles')}</DialogTitle>
            <DialogDescription>{t('kubecode.chooseFileReference')}</DialogDescription>
          </DialogHeader>
          {projectId && (
            <ProjectFilePicker
              api={api}
              onEscape={() => setQuickOpen(false)}
              onOpenFile={(entry) => {
                setQuickOpen(false)
                void openEntry(entry)
              }}
              projectId={projectId}
              recentPaths={projectDocuments.map((item) => item.document.path).reverse()}
              refreshVersion={fileTreeRevision}
              t={t}
            />
          )}
        </DialogContent>
      </Dialog>
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
      <Dialog
        open={Boolean(closeDocumentKey)}
        onOpenChange={(open) => {
          if (!open) setCloseDocumentKey(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('kubecode.unsavedChanges')}</DialogTitle>
            <DialogDescription>{t('kubecode.unsavedChangesDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">{t('kubecode.cancel')}</Button></DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (closeDocumentKey) closeEditor(closeDocumentKey, true)
                setCloseDocumentKey(null)
              }}
            >
              {t('kubecode.discard')}
            </Button>
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
  onCreated: (entry: Entry) => void
  t: Translator
}) {
  const [path, setPath] = useState(directory ? `${directory}/` : '')
  const [directories, setDirectories] = useState<Entry[]>([])
  const [collision, setCollision] = useState(false)
  const [loading, setLoading] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const normalizedPath = normalizeRelativePath(path)

  useEffect(() => {
    if (!projectId || !state) return
    let current = true
    const timeout = window.setTimeout(() => {
      setLoading(true)
      const parent = normalizedPath.split('/').slice(0, -1).join('/')
      const directoryQuery = parent || normalizedPath
      void Promise.all([
        api.listEntries(projectId, parent),
        searchProjectEntries({
          api,
          kind: 'directory',
          maxEntries: 2_000,
          maxResults: 100,
          projectId,
          query: directoryQuery,
        }),
      ]).then(([siblings, nextDirectories]) => {
        if (!current) return
        const name = normalizedPath.split('/').at(-1)
        setCollision(Boolean(name && siblings.some((entry) => entry.name === name)))
        setDirectories(nextDirectories)
      }).catch((cause: unknown) => {
        if (current) setCreateError(errorMessage(cause, t('kubecode.error')))
      }).finally(() => {
        if (current) setLoading(false)
      })
    }, 120)
    return () => {
      current = false
      window.clearTimeout(timeout)
    }
  }, [api, normalizedPath, projectId, state, t])

  const create = async () => {
    if (!projectId || !state || !normalizedPath || collision) return
    setCreateError(null)
    try {
      await api.createEntry(projectId, normalizedPath, state.kind)
      const entry: Entry = {
        kind: state.kind,
        name: normalizedPath.split('/').at(-1) ?? normalizedPath,
        path: normalizedPath,
      }
      setPath('')
      onOpenChange(false)
      onCreated(entry)
    } catch (cause) {
      setCreateError(errorMessage(cause, t('kubecode.error')))
    }
  }

  const rows = useMemo<PathPickerRow[]>(() => {
    const action: PathPickerRow[] = normalizedPath ? [{
      description: collision ? t('kubecode.pathAlreadyExists') : t('kubecode.pressEnterToCreate'),
      disabled: collision,
      id: 'create-entry',
      kind: 'action',
      label: `${t('kubecode.create')} ${normalizedPath}`,
      path: normalizedPath,
    }] : []
    return [
      ...action,
      ...directories
        .filter((entry) => entry.path !== normalizedPath)
        .map((entry) => ({
          description: entry.path,
          id: `directory-${entry.path}`,
          kind: 'directory' as const,
          label: entry.name,
          path: entry.path,
        })),
    ]
  }, [collision, directories, normalizedPath, t])

  return (
    <Dialog open={Boolean(state)} onOpenChange={onOpenChange}>
      <DialogContent className="kubecode-path-picker-dialog" showCloseButton={false}>
        <DialogHeader className="kubecode-path-picker-heading">
          <DialogTitle>{state?.kind === 'directory' ? t('kubecode.newFolder') : t('kubecode.newFile')}</DialogTitle>
          <DialogDescription>{t('kubecode.entryPath')}</DialogDescription>
        </DialogHeader>
        <PathPicker
          ariaLabel={t('kubecode.entryPath')}
          emptyMessage={t('kubecode.noDirectoriesFound')}
          footer={createError ? (
            <div className="kubecode-path-picker-error" role="alert">{createError}</div>
          ) : undefined}
          loading={loading}
          loadingMessage={t('kubecode.loading')}
          onEscape={() => onOpenChange(false)}
          onQueryChange={setPath}
          onSelect={(row) => {
            if (row.kind === 'action') {
              void create()
            } else {
              setPath(`${row.path}/`)
            }
          }}
          placeholder={t('kubecode.entryPath')}
          query={path}
          rows={rows}
        />
      </DialogContent>
    </Dialog>
  )
}

function normalizeRelativePath(path: string): string {
  return path.trim().replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/')
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

function documentKey(projectId: string, path: string): string {
  return `${projectId}:${path}`
}
