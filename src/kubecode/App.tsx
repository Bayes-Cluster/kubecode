import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  File,
  Folder,
  FolderOpen,
  Plus,
  TerminalWindow,
  Trash,
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
import { createTranslator, resolveEffectiveLocale } from '@/lib/i18n'
import { trackEvent } from '@/lib/telemetry'

import { AgentPanel } from './AgentPanel'
import { CodeEditor } from './CodeEditor'
import { KubecodeApi } from './api'
import type {
  AgentDescriptor,
  Conversation,
  Entry,
  Project,
  TerminalInfo,
  TextDocument,
} from './api'
import { TerminalView } from './TerminalView'
import './kubecode.css'

type EntryDialogState = { kind: Entry['kind'] } | null
const browserApi = new KubecodeApi()

export function KubecodeApp({ api = browserApi }: { api?: KubecodeApi }) {
  const locale = useMemo(() => resolveEffectiveLocale(null), [])
  const t = useMemo(() => createTranslator(locale), [locale])
  const [projects, setProjects] = useState<Project[]>([])
  const [agents, setAgents] = useState<AgentDescriptor[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [entries, setEntries] = useState<Entry[]>([])
  const [directory, setDirectory] = useState('')
  const [document, setDocument] = useState<TextDocument | null>(null)
  const [draft, setDraft] = useState('')
  const [terminals, setTerminals] = useState<TerminalInfo[]>([])
  const [terminalId, setTerminalId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [projectDialog, setProjectDialog] = useState(false)
  const [entryDialog, setEntryDialog] = useState<EntryDialogState>(null)
  const [error, setError] = useState<string | null>(null)
  const project = projects.find((item) => item.id === projectId) ?? null
  const terminal = terminals.find((item) => item.id === terminalId) ?? terminals[0]
  const dirty = Boolean(document && document.content !== draft)

  useEffect(() => {
    let active = true
    Promise.all([api.listProjects(), api.listAgents()])
      .then(([nextProjects, nextAgents]) => {
        if (!active) return
        setProjects(nextProjects)
        setAgents(nextAgents)
        setProjectId((current) => current ?? nextProjects[0]?.id ?? null)
      })
      .catch((cause: unknown) => setError(errorMessage(cause, t('kubecode.error'))))
    return () => { active = false }
  }, [api, t])

  useEffect(() => {
    if (!projectId) return
    let active = true
    Promise.all([
      api.listEntries(projectId),
      api.listTerminals(projectId),
      api.listConversations(projectId),
    ])
      .then(([nextEntries, nextTerminals, nextConversations]) => {
        if (!active) return
        setDirectory('')
        setDocument(null)
        setDraft('')
        setEntries(nextEntries)
        setTerminals(nextTerminals)
        setTerminalId(nextTerminals[0]?.id ?? null)
        setConversations(nextConversations)
      })
      .catch((cause: unknown) => setError(errorMessage(cause, t('kubecode.error'))))
    return () => { active = false }
  }, [api, projectId, t])

  const selectProject = (nextProjectId: string) => {
    setDirectory('')
    setDocument(null)
    setDraft('')
    setEntries([])
    setProjectId(nextProjectId)
  }

  const refreshEntries = async (path = directory) => {
    if (!projectId) return
    setEntries(await api.listEntries(projectId, path))
  }

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
  }

  const goBack = async () => {
    const parent = directory.includes('/') ? directory.slice(0, directory.lastIndexOf('/')) : ''
    setDirectory(parent)
    await refreshEntries(parent)
  }

  const save = async () => {
    if (!projectId || !document || !dirty) return
    try {
      const saved = await api.writeFile(
        projectId,
        document.path,
        draft,
        document.revision,
      )
      setDocument(saved)
      setDraft(saved.content)
      trackEvent('kubecode_file_saved', { source: 'editor' })
    } catch (cause) {
      setError(errorMessage(cause, t('kubecode.error')))
    }
  }

  const createTerminal = async () => {
    if (!projectId) return
    const created = await api.createTerminal(projectId, 100, 28)
    setTerminals((current) => [...current, created])
    setTerminalId(created.id)
    trackEvent('kubecode_terminal_created')
  }

  const closeTerminal = async (id: string) => {
    await api.closeTerminal(id)
    setTerminals((current) => current.filter((item) => item.id !== id))
    if (terminalId === id) setTerminalId(null)
  }

  return (
    <main className="kubecode-app">
      <header className="kubecode-topbar">
        <div className="kubecode-brand"><span>K</span>{t('kubecode.appName')}</div>
        <div className="kubecode-project-path">{project?.path ?? t('kubecode.selectProject')}</div>
        {error && <div className="kubecode-inline-error">{error}</div>}
      </header>
      <div className="kubecode-workspace">
        <aside className="kubecode-sidebar">
          <div className="kubecode-section-heading">
            <strong>{t('kubecode.projects')}</strong>
            <Button
              aria-label={t('kubecode.addProject')}
              size="icon-xs"
              variant="ghost"
              onClick={() => setProjectDialog(true)}
            ><Plus /></Button>
          </div>
          <div className="kubecode-project-list">
            {projects.map((item) => (
              <Button
                className="kubecode-list-button"
                key={item.id}
                variant={item.id === projectId ? 'secondary' : 'ghost'}
                onClick={() => selectProject(item.id)}
              >
                <FolderOpen /> <span>{item.name}</span>
              </Button>
            ))}
          </div>
          <div className="kubecode-section-heading kubecode-files-heading">
            <strong>{t('kubecode.files')}</strong>
            <div>
              <Button
                aria-label={t('kubecode.newFile')}
                disabled={!projectId}
                size="icon-xs"
                variant="ghost"
                onClick={() => setEntryDialog({ kind: 'file' })}
              ><File /></Button>
              <Button
                aria-label={t('kubecode.newFolder')}
                disabled={!projectId}
                size="icon-xs"
                variant="ghost"
                onClick={() => setEntryDialog({ kind: 'directory' })}
              ><Folder /></Button>
            </div>
          </div>
          {directory && (
            <Button className="kubecode-list-button" variant="ghost" onClick={() => void goBack()}>
              <ArrowLeft /> {t('kubecode.back')}
            </Button>
          )}
          <div className="kubecode-file-list">
            {entries.map((entry) => (
              <Button
                className="kubecode-list-button"
                key={entry.path}
                variant={document?.path === entry.path ? 'secondary' : 'ghost'}
                onClick={() => void openEntry(entry)}
              >
                {entry.kind === 'directory' ? <Folder /> : <File />}
                <span>{entry.name}</span>
              </Button>
            ))}
            {projectId && entries.length === 0 && (
              <div className="kubecode-empty-small">{t('kubecode.emptyDirectory')}</div>
            )}
          </div>
        </aside>

        <section className="kubecode-center">
          <div className="kubecode-editor-pane">
            <div className="kubecode-panel-header">
              <strong>{document?.path ?? t('kubecode.editor')}</strong>
              <div className="kubecode-editor-actions">
                {dirty && <span>{t('kubecode.unsaved')}</span>}
                <Button disabled={!dirty} size="sm" onClick={() => void save()}>
                  {t('kubecode.save')}
                </Button>
              </div>
            </div>
            {document ? (
              <CodeEditor
                content={document.content}
                documentKey={`${document.path}:${document.revision}`}
                onChange={setDraft}
              />
            ) : (
              <div className="kubecode-empty-editor">
                <File size={36} />
                <span>{projectId ? t('kubecode.selectFile') : t('kubecode.selectProject')}</span>
                <Button
                  disabled={!projectId}
                  variant="outline"
                  onClick={() => setEntryDialog({ kind: 'file' })}
                >
                  <Plus /> {t('kubecode.newFile')}
                </Button>
              </div>
            )}
          </div>
          <div className="kubecode-terminal-pane">
            <div className="kubecode-terminal-tabs">
              <TerminalWindow />
              {terminals.map((item, index) => (
                <Button
                  key={item.id}
                  size="xs"
                  variant={item.id === terminal?.id ? 'secondary' : 'ghost'}
                  onClick={() => setTerminalId(item.id)}
                >
                  {t('kubecode.terminal')} {index + 1}
                </Button>
              ))}
              <Button
                aria-label={t('kubecode.newTerminal')}
                disabled={!projectId}
                size="icon-xs"
                variant="ghost"
                onClick={() => void createTerminal()}
              ><Plus /></Button>
              {terminal && (
                <Button
                  aria-label={t('kubecode.closeTerminal')}
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => void closeTerminal(terminal.id)}
                ><Trash /></Button>
              )}
            </div>
            {projectId && terminal ? (
              <TerminalView api={api} projectId={projectId} terminal={terminal} />
            ) : (
              <div className="kubecode-empty-small">{t('kubecode.newTerminal')}</div>
            )}
          </div>
        </section>

        {projectId ? (
          <AgentPanel
            agents={agents}
            api={api}
            conversations={conversations}
            key={projectId}
            onConversationCreated={(conversation) => {
              setConversations((current) => [...current, conversation])
            }}
            projectId={projectId}
            t={t}
          />
        ) : (
          <aside className="kubecode-agent-panel kubecode-empty">{t('kubecode.selectProject')}</aside>
        )}
      </div>
      <ProjectDialog
        api={api}
        open={projectDialog}
        onOpenChange={setProjectDialog}
        onProject={(created) => {
          setProjects((current) => [...current, created])
          selectProject(created.id)
        }}
        t={t}
      />
      <EntryDialog
        api={api}
        directory={directory}
        projectId={projectId}
        state={entryDialog}
        onOpenChange={(open) => { if (!open) setEntryDialog(null) }}
        onCreated={() => void refreshEntries()}
        t={t}
      />
    </main>
  )
}

type Translator = ReturnType<typeof createTranslator>

function ProjectDialog({
  api,
  open,
  onOpenChange,
  onProject,
  t,
}: {
  api: KubecodeApi
  open: boolean
  onOpenChange: (open: boolean) => void
  onProject: (project: Project) => void
  t: Translator
}) {
  const [mode, setMode] = useState<'create' | 'import'>('create')
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [parent, setParent] = useState('.')

  const submit = async () => {
    const project = mode === 'create'
      ? await api.createProject(parent, name)
      : await api.importProject(path, name || undefined)
    trackEvent('kubecode_project_registered', { mode })
    onProject(project)
    setName('')
    setPath('')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? t('kubecode.createProject') : t('kubecode.importProject')}</DialogTitle>
          <DialogDescription>{t('kubecode.projectPath')}</DialogDescription>
        </DialogHeader>
        <div className="kubecode-mode-switch">
          <Button variant={mode === 'create' ? 'default' : 'outline'} onClick={() => setMode('create')}>
            {t('kubecode.createProject')}
          </Button>
          <Button variant={mode === 'import' ? 'default' : 'outline'} onClick={() => setMode('import')}>
            {t('kubecode.importProject')}
          </Button>
        </div>
        {mode === 'create' && (
          <Input aria-label={t('kubecode.projectParent')} value={parent} onChange={(event) => setParent(event.target.value)} />
        )}
        {mode === 'import' && (
          <Input aria-label={t('kubecode.projectPath')} value={path} onChange={(event) => setPath(event.target.value)} />
        )}
        <Input
          aria-label={t('kubecode.projectName')}
          placeholder={t('kubecode.projectName')}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">{t('kubecode.cancel')}</Button></DialogClose>
          <Button disabled={mode === 'create' ? !name.trim() : !path.trim()} onClick={() => void submit()}>
            {mode === 'create' ? t('kubecode.create') : t('kubecode.import')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
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
        <Input
          aria-label={t('kubecode.entryPath')}
          value={path}
          onChange={(event) => setPath(event.target.value)}
        />
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
