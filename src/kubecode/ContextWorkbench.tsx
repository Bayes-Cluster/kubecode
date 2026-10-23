import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ChevronDown,
  File,
  Folder,
  GitCommitHorizontal,
  GitCompare,
  Minus,
  Plus,
  RotateCw,
  Search,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-react'
import { Virtuoso } from 'react-virtuoso'

import { IconButton } from '@/components/workspace/IconButton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Item, ItemContent, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import type { Translator } from '@/lib/i18n'
import { trackEvent } from '@/lib/telemetry'

import { CodeEditor } from './CodeEditor'
import { Icon } from './icons'
import { PLAN_STATUS_ICONS } from './icons/statusIcons'
import { MaterialFileIcon } from './icons/material/materialIcons'
import { resolveFileIcon } from './icons/resolveFileIcon'
import { GIT_STATE_ICONS, type GitState } from './icons/statusIcons'
import type { SessionPlanEntry } from './AgentSessionWorkspace'
import type { WorkspaceConnectionState } from './useWorkspaceEventStream'
import { PathPicker, type PathPickerRow } from './PathPicker'
import { ProjectFilePicker } from './ProjectFilePicker'
import { ProjectFileTree } from './ProjectFileTree'
import {
  EMPTY_FILE_TREE_INVALIDATIONS,
  aggregateFileChangedEvents,
  type FileTreeInvalidation,
} from './fileTreeInvalidation'
import { searchProjectEntries } from './projectPathSearch'
import { SystemMessageNotice } from './SystemMessageNotice'
import { useSystemMessages } from './systemMessages'
import { useGitStatusController } from './useGitStatusController'
import { GitDiffView } from './GitDiffView'
import { useGitDiff, type GitDiffTarget } from './useGitDiff'
import type {
  Entry,
  GitFileChange,
  KubecodeApi,
  TextDocument,
  WorkspaceEvent,
} from './api'

type EntryDialogState = { kind: Entry['kind'] } | null
type OpenDocument = {
  document: TextDocument
  draft: string
  projectId: string
}

const GIT_GROUP_VIRTUALIZATION_THRESHOLD = 200

type ContextWorkbenchProps = {
  api: KubecodeApi
  autoSave?: boolean
  connectionState?: WorkspaceConnectionState
  /** In the phone Sheet: the tab bar leaves room for the Sheet's own close button. */
  inSheet?: boolean
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
  connectionState = 'live',
  inSheet = false,
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
  const { state: diffState, open: requestDiff, close: closeDiff } = useGitDiff(api)
  const [commitMessage, setCommitMessage] = useState('')
  const [committing, setCommitting] = useState(false)
  const committingRef = useRef(false)
  const [discardPath, setDiscardPath] = useState<string | null>(null)
  const systemMessages = useSystemMessages()
  const processedWorkspaceEventRef = useRef(workspaceEvents.at(-1)?.id ?? 0)
  const lastForwardedFileEventIdRef = useRef(0)
  const previousConnectionStateRef = useRef(connectionState)
  const savingDocumentsRef = useRef(new Set<string>())
  const [fileTreeInvalidation, setFileTreeInvalidation] = useState<FileTreeInvalidation | null>(null)
  const reportError = useCallback((cause: unknown) => {
    const message = errorMessage(cause, t('kubecode.error'))
    if (systemMessages) {
      systemMessages.publish({ level: 'error', message, source: t('kubecode.changes') })
    } else {
      setError(message)
    }
  }, [systemMessages, t])
  const {
    applyMutationResult,
    beginMutation,
    cancelMutation,
    gitStatus,
    refresh: refreshGitStatus,
  } = useGitStatusController({
    api,
    onError: reportError,
    projectId,
    workspaceEvents,
  })
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

  useEffect(() => {
    setTab('explorer')
    setActiveDocumentKey(null)
    closeDiff()
    setSelectedDirectory('')
  }, [closeDiff, projectId])

  useEffect(() => {
    if (!projectId) return
    const nextEvents = workspaceEvents.filter((event) => (
      event.id > processedWorkspaceEventRef.current && event.project_id === projectId
    ))
    processedWorkspaceEventRef.current = workspaceEvents.at(-1)?.id
      ?? processedWorkspaceEventRef.current
    const unforwardedFileEvents = nextEvents.filter(
      (event) => event.kind === 'file_changed'
        && event.id > lastForwardedFileEventIdRef.current,
    )
    if (unforwardedFileEvents.length > 0) {
      lastForwardedFileEventIdRef.current = unforwardedFileEvents.at(-1)?.id
        ?? lastForwardedFileEventIdRef.current
      setFileTreeInvalidation({
        id: lastForwardedFileEventIdRef.current,
        payload: aggregateFileChangedEvents(unforwardedFileEvents),
      })
    }
  }, [projectId, workspaceEvents])

  useEffect(() => {
    const opened = connectionState === 'live' && previousConnectionStateRef.current !== 'live'
    previousConnectionStateRef.current = connectionState
    if (!opened || !projectId) return
    setFileTreeRevision((current) => current + 1)
    refreshGitStatus()
  }, [connectionState, projectId, refreshGitStatus])

  useEffect(() => {
    const openQuickFile = (event: KeyboardEvent) => {
      if (!projectId || event.defaultPrevented) return
      if (!event.altKey
        && !event.shiftKey
        && (event.metaKey || event.ctrlKey)
        && event.key.toLocaleLowerCase() === 'p') {
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

  const openDiff = (change: GitFileChange, staged: boolean) => {
    if (!projectId) return
    requestDiff({ projectId, path: change.path, staged })
    setTab('diff')
  }

  const retryDiff = (target: GitDiffTarget) => {
    requestDiff(target)
  }

  const mutateGit = async (action: 'stage' | 'unstage' | 'discard', path: string) => {
    if (!projectId) return
    beginMutation(action)
    try {
      applyMutationResult(await api.mutateGit(projectId, action, [path]))
      trackEvent('kubecode_git_action_used', { action })
    } catch (cause) {
      cancelMutation(action)
      reportError(cause)
    }
  }

  const commit = async () => {
    if (!projectId || !commitMessage.trim() || committingRef.current) return
    committingRef.current = true
    setCommitting(true)
    beginMutation('commit')
    try {
      applyMutationResult(await api.commitGit(projectId, commitMessage))
      setCommitMessage('')
      trackEvent('kubecode_git_action_used', { action: 'commit' })
    } catch (cause) {
      cancelMutation('commit')
      reportError(cause)
    } finally {
      committingRef.current = false
      setCommitting(false)
    }
  }

  const initializeGit = async () => {
    if (!projectId) return
    beginMutation('init')
    try {
      applyMutationResult(await api.initializeGit(projectId))
      trackEvent('kubecode_git_action_used', { action: 'init' })
    } catch (cause) {
      cancelMutation('init')
      reportError(cause)
    }
  }

  const conflictChanges = gitStatus?.files.filter(isConflict) ?? []
  const stagedChanges = gitStatus?.files.filter(isStaged) ?? []
  const worktreeChanges = gitStatus?.files.filter(isWorktreeChanged) ?? []

  const refreshContext = () => {
    setFileTreeRevision((current) => current + 1)
    refreshGitStatus()
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
        <div className={cn('flex h-9 shrink-0 items-center justify-between gap-1 border-b px-1', inSheet && 'pr-12')}>
          <TabsList className="min-w-0 justify-start overflow-x-auto" variant="line">
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
                  <MaterialFileIcon id={resolveFileIcon(item.document.path)} /> {item.document.path.split('/').at(-1)}
                  {itemDirty && <span aria-label={t('kubecode.unsaved')} className="size-1.5 shrink-0 rounded-full bg-warning" role="img" />}
                </TabsTrigger>
              )
            })}
            {diffState.kind !== 'idle' && (
              <TabsTrigger value="diff" onClick={() => setTab('diff')}>
                <MaterialFileIcon id={resolveFileIcon(diffState.target.path)} /> {t('kubecode.diffTab', { file: diffState.target.path.split('/').at(-1) ?? '' })}
              </TabsTrigger>
            )}
          </TabsList>
          <div className="flex shrink-0 items-center gap-px">
            {tab === 'explorer' && (
              <>
                <IconButton disabled={!projectId} icon={<Search />} label={t('kubecode.searchFiles')} onClick={() => setQuickOpen(true)} />
                <IconButton disabled={!projectId} icon={<File />} label={t('kubecode.newFile')} onClick={() => setEntryDialog({ kind: 'file' })} />
                <IconButton disabled={!projectId} icon={<Folder />} label={t('kubecode.newFolder')} onClick={() => setEntryDialog({ kind: 'directory' })} />
              </>
            )}
            <IconButton icon={<RotateCw />} label={t('kubecode.refresh')} onClick={refreshContext} />
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
              <Empty className="p-4 md:p-6">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><GitCompare /></EmptyMedia>
                  <EmptyTitle>{t('kubecode.createGitRepository')}</EmptyTitle>
                  <EmptyDescription>{t('kubecode.createGitRepositoryDescription')}</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button disabled={!projectId} size="sm" onClick={() => void initializeGit()}>{t('kubecode.createGitRepository')}</Button>
                </EmptyContent>
              </Empty>
            ) : gitStatus.files.length === 0 ? (
              <Empty className="p-4">
                <EmptyHeader>
                  <EmptyTitle>{t('kubecode.noChanges')}</EmptyTitle>
                  <EmptyDescription>{t('kubecode.reviewDescription')}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="kubecode-review-body">
                {gitStatus.truncated && (
                  <Alert className="my-1" role="status">
                    <TriangleAlert />
                    <AlertDescription>{t('kubecode.gitStatusTruncated', { count: gitStatus.files.length })}</AlertDescription>
                  </Alert>
                )}
                {conflictChanges.length > 0 && (
                  <GitChangeGroup
                    changes={conflictChanges}
                    group="conflict"
                    label={t('kubecode.conflicts')}
                    onDiff={(change) => void openDiff(change, false)}
                    statusColumn="conflict"
                    t={t}
                  />
                )}
                {conflictChanges.length > 0 && (
                  <Alert className="my-1" role="status">
                    <TriangleAlert />
                    <AlertDescription>{t('kubecode.conflictHint')}</AlertDescription>
                  </Alert>
                )}
                {stagedChanges.length > 0 && (
                  <GitChangeGroup
                    changes={stagedChanges}
                    group="staged"
                    label={t('kubecode.stagedChanges')}
                    onDiff={(change) => void openDiff(change, true)}
                    onPrimary={(change) => void mutateGit('unstage', change.path)}
                    primaryLabel={t('kubecode.unstage')}
                    primaryIcon={<Minus />}
                    statusColumn="index"
                    t={t}
                  />
                )}
                {worktreeChanges.length > 0 && (
                  <GitChangeGroup
                    changes={worktreeChanges}
                    group="worktree"
                    // Alone, the worktree group is what the section already names.
                    label={stagedChanges.length > 0 || conflictChanges.length > 0 ? t('kubecode.changes') : undefined}
                    onDiff={(change) => void openDiff(change, false)}
                    onDiscard={(change) => setDiscardPath(change.path)}
                    onPrimary={(change) => void mutateGit('stage', change.path)}
                    primaryLabel={t('kubecode.stage')}
                    primaryIcon={<Plus />}
                    discardLabel={t('kubecode.discard')}
                    statusColumn="worktree"
                    t={t}
                  />
                )}
                {stagedChanges.length > 0 && (
                  <InputGroup className="mt-2">
                    <InputGroupInput
                      aria-label={t('kubecode.commitMessage')}
                      placeholder={t('kubecode.commitMessage')}
                      value={commitMessage}
                      onChange={(event) => setCommitMessage(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.repeat && !event.nativeEvent.isComposing) void commit()
                      }}
                    />
                    <InputGroupAddon align="inline-end">
                      <InputGroupButton disabled={committing || !commitMessage.trim()} size="sm" variant="default" onClick={() => void commit()}>
                        <GitCommitHorizontal data-icon="inline-start" /> {t('kubecode.commit')}
                      </InputGroupButton>
                    </InputGroupAddon>
                  </InputGroup>
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
              <ItemGroup className="p-1" role="list">
                {planEntries.map((entry, index) => (
                  <Item
                    data-priority={entry.priority}
                    data-status={entry.status}
                    key={`${index}-${entry.content}`}
                    role="listitem"
                    size="sm"
                  >
                    <ItemMedia aria-hidden="true">
                      <Icon role="status" size="secondary" source={PLAN_STATUS_ICONS[entry.status].Icon} />
                    </ItemMedia>
                    <ItemContent>
                      {/* The glyph is drawn for the eye; the status is said in words. */}
                      <ItemTitle className="font-normal">
                        <span className="sr-only">{t(PLAN_STATUS_ICONS[entry.status].labelKey)}: </span>
                        {entry.content}
                      </ItemTitle>
                    </ItemContent>
                  </Item>
                ))}
              </ItemGroup>
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
                invalidations={fileTreeInvalidation
                  ? [fileTreeInvalidation]
                  : EMPTY_FILE_TREE_INVALIDATIONS}
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
            <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b px-3">
              <span className="min-w-0 truncate text-sm text-muted-foreground" title={activeDocument.document.path}>{activeDocument.document.path}</span>
              <div className="flex shrink-0 items-center gap-1.5">
                {dirty && <Badge variant="warning">{t('kubecode.unsaved')}</Badge>}
                <Button disabled={!dirty} size="xs" onClick={() => void save()}>{t('kubecode.save')}</Button>
                <IconButton
                  icon={<X />}
                  label={t('kubecode.closeEditor')}
                  onClick={() => closeEditor(activeDocumentKey as string)}
                />
              </div>
            </div>
            <CodeEditor
              content={activeDocument.draft}
              documentKey={documentKey(activeDocument.projectId, activeDocument.document.path)}
              onChange={(draft) => setDocuments((current) => current.map((item) => (
                documentKey(item.projectId, item.document.path) === activeDocumentKey
                  ? { ...item, draft }
                  : item
              )))}
            />
          </TabsContent>
        )}
        {diffState.kind !== 'idle' && (
          <TabsContent className="kubecode-context-content kubecode-diff-view" value="diff">
            <GitDiffView
              state={diffState}
              onClose={() => {
                closeDiff()
                setTab('explorer')
              }}
              onRetry={retryDiff}
              t={t}
            />
          </TabsContent>
        )}
      </Tabs>
      {error && (
        <SystemMessageNotice
          detailsLabel={t('kubecode.details')}
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
      <AlertDialog open={Boolean(discardPath)} onOpenChange={(open) => { if (!open) setDiscardPath(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('kubecode.discardChanges')}</AlertDialogTitle>
            <AlertDialogDescription>{t('kubecode.discardChangesDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('kubecode.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (discardPath) void mutateGit('discard', discardPath)
                setDiscardPath(null)
              }}
            >
              <Trash2 data-icon="inline-start" /> {t('kubecode.discard')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={Boolean(closeDocumentKey)}
        onOpenChange={(open) => {
          if (!open) setCloseDocumentKey(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('kubecode.unsavedChanges')}</AlertDialogTitle>
            <AlertDialogDescription>{t('kubecode.unsavedChangesDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('kubecode.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (closeDocumentKey) closeEditor(closeDocumentKey, true)
                setCloseDocumentKey(null)
              }}
            >
              {t('kubecode.discard')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
    <Collapsible
      asChild
      open={expanded}
      onOpenChange={(nextExpanded) => {
        onExpandedChange(nextExpanded)
        if (nextExpanded) trackEvent('kubecode_context_section_opened', { section })
      }}
    >
      <section className="kubecode-explorer-section" data-expanded={expanded} data-fill={fill}>
        <CollapsibleTrigger asChild>
          <Button
            className="h-7 w-full shrink-0 justify-start gap-1.5 rounded-none px-2 text-xs font-semibold uppercase text-muted-foreground [&[data-state=closed]>svg]:-rotate-90"
            size="sm"
            variant="ghost"
          >
            <ChevronDown data-icon="inline-start" />
            <span className="min-w-0 truncate">{label}</span>
            {typeof count === 'number' && count > 0 && <Badge className="ml-auto" variant="secondary">{count}</Badge>}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="kubecode-explorer-section-content">{children}</CollapsibleContent>
      </section>
    </Collapsible>
  )
}

function GitChangeGroup({
  changes,
  group,
  label,
  onDiff,
  onDiscard,
  onPrimary,
  primaryIcon,
  primaryLabel,
  statusColumn,
  discardLabel,
  t,
}: {
  changes: GitFileChange[]
  group: 'conflict' | 'staged' | 'worktree'
  label?: string
  onDiff: (change: GitFileChange) => void
  onDiscard?: (change: GitFileChange) => void
  onPrimary?: (change: GitFileChange) => void
  primaryIcon?: ReactNode
  primaryLabel?: string
  statusColumn: 'conflict' | 'index' | 'worktree'
  discardLabel?: string
  t: Translator
}) {
  const isVirtualized = changes.length > GIT_GROUP_VIRTUALIZATION_THRESHOLD

  return (
    <section className="kubecode-git-group" data-group={group} data-virtualized={isVirtualized || undefined}>
      {label && (
        <header className="flex h-7 items-center justify-between px-1.5 text-xs font-semibold uppercase text-muted-foreground">
          <span>{label}</span>
          <Badge variant="secondary">{changes.length}</Badge>
        </header>
      )}
      {isVirtualized ? (
        <Virtuoso
          className="kubecode-git-virtual-list"
          computeItemKey={(_index, change) => `${group}:${change.path}`}
          data={changes}
          data-testid={`git-change-virtual-list-${group}`}
          defaultItemHeight={36}
          fixedItemHeight={36}
          increaseViewportBy={{ bottom: 216, top: 216 }}
          itemContent={(_index, change) => (
            <GitChangeRow
              change={change}
              discardLabel={discardLabel}
              onDiscard={onDiscard}
              onDiff={onDiff}
              onPrimary={onPrimary}
              primaryIcon={primaryIcon}
              primaryLabel={primaryLabel}
              statusColumn={statusColumn}
              t={t}
            />
          )}
        />
      ) : changes.map((change) => (
        <GitChangeRow
          change={change}
          discardLabel={discardLabel}
          key={`${group}:${change.path}`}
          onDiscard={onDiscard}
          onDiff={onDiff}
          onPrimary={onPrimary}
          primaryIcon={primaryIcon}
          primaryLabel={primaryLabel}
          statusColumn={statusColumn}
          t={t}
        />
      ))}
    </section>
  )
}

function GitChangeRow({
  change,
  discardLabel,
  onDiscard,
  onDiff,
  onPrimary,
  primaryIcon,
  primaryLabel,
  statusColumn,
  t,
}: {
  change: GitFileChange
  discardLabel?: string
  onDiscard?: (change: GitFileChange) => void
  onDiff: (change: GitFileChange) => void
  onPrimary?: (change: GitFileChange) => void
  primaryIcon?: ReactNode
  primaryLabel?: string
  statusColumn: 'conflict' | 'index' | 'worktree'
  t: Translator
}) {
  const state = gitStateKey(change, statusColumn)
  const stateEntry = GIT_STATE_ICONS[state]
  return (
    <div className="kubecode-git-row">
      <Button className="kubecode-git-path justify-start" variant="ghost" onClick={() => onDiff(change)}>
        <MaterialFileIcon id={resolveFileIcon(change.path)} />
        <span className="kubecode-git-path-name">
          {change.original_path && (
            <small className="kubecode-git-rename-source">
              {change.original_path} →
            </small>
          )}
          <span>{change.path}</span>
        </span>
        <span
          aria-label={t(stateEntry.labelKey)}
          className="kubecode-git-state"
          data-state={state}
          role="img"
        >
          <Icon role="status" size="status" source={stateEntry.Icon} />
          <code aria-hidden="true">{gitStatusColumn(change, statusColumn)}</code>
        </span>
      </Button>
      {onDiscard && (
        <IconButton icon={<Trash2 />} label={`${discardLabel}: ${change.path}`} onClick={() => onDiscard(change)} />
      )}
      {onPrimary && primaryIcon && (
        <IconButton icon={primaryIcon} label={`${primaryLabel}: ${change.path}`} onClick={() => onPrimary(change)} />
      )}
    </div>
  )
}

function isConflict(change: GitFileChange): boolean {
  return change.conflict === true
}

function isStaged(change: GitFileChange): boolean {
  return Boolean(change.index_status && change.index_status !== '?')
    && !isConflict(change)
}

function isWorktreeChanged(change: GitFileChange): boolean {
  return Boolean(change.worktree_status || change.index_status === '?')
    && !isConflict(change)
}

function gitStateKey(
  change: GitFileChange,
  column: 'conflict' | 'index' | 'worktree',
): GitState {
  const code = gitStatusColumn(change, column)
  const char = code.replace(/\?/g, '').charAt(0) || code.charAt(0)
  if (char === 'A' || char === 'C') return 'added'
  if (char === 'D') return 'deleted'
  if (char === 'R') return 'renamed'
  if (char === '?') return 'untracked'
  return 'modified'
}

function gitStatusColumn(
  change: GitFileChange,
  column: 'conflict' | 'index' | 'worktree',
): string {
  if (column === 'index') return change.index_status ?? ''
  if (column === 'worktree') return change.worktree_status ?? ''
  return `${change.index_status ?? ''}${change.worktree_status ?? ''}` || '?'
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
            <Alert className="m-2 w-auto" variant="destructive"><AlertDescription>{createError}</AlertDescription></Alert>
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
