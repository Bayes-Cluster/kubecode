import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  CaretLeft,
  Gear,
  MagnifyingGlass,
  Plus,
  Question,
  SidebarSimple,
  TerminalWindow,
} from '@phosphor-icons/react'

import { AiAgentIcon } from '@/components/AiAgentIcon'
import { ResizeHandle } from '@/components/ResizeHandle'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { createTranslator, resolveEffectiveLocale } from '@/lib/i18n'
import { trackEvent } from '@/lib/telemetry'
import {
  applyThemeSelectionToDocument,
  readStoredThemeMode,
  writeStoredThemeMode,
  type ThemeMode,
} from '@/lib/themeMode'

import { AgentSessionWorkspace } from './AgentSessionWorkspace'
import { ContextWorkbench } from './ContextWorkbench'
import { KubecodeApi } from './api'
import type {
  AgentDescriptor,
  AgentId,
  Conversation,
  Project,
  TerminalInfo,
  WorkspaceEvent,
} from './api'
import { TerminalWorkspace } from './TerminalWorkspace'
import './kubecode.css'

const browserApi = new KubecodeApi()

export function KubecodeApp({ api = browserApi }: { api?: KubecodeApi }) {
  const locale = useMemo(() => resolveEffectiveLocale(null), [])
  const t = useMemo(() => createTranslator(locale), [locale])
  const [projects, setProjects] = useState<Project[]>([])
  const [agents, setAgents] = useState<AgentDescriptor[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [terminals, setTerminals] = useState<TerminalInfo[]>([])
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [projectDialog, setProjectDialog] = useState(false)
  const [sessionDialog, setSessionDialog] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sessionSidebarOpen, setSessionSidebarOpen] = useState(true)
  const [contextOpen, setContextOpen] = useState(true)
  const [terminalOpen, setTerminalOpen] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [workspaceEvent, setWorkspaceEvent] = useState<WorkspaceEvent | null>(null)
  const [sessionSidebarWidth, setSessionSidebarWidth] = useState(280)
  const [contextWidth, setContextWidth] = useState(440)
  const [terminalHeight, setTerminalHeight] = useState(260)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const mainStackRef = useRef<HTMLDivElement>(null)
  const project = projects.find((item) => item.id === projectId) ?? null
  const conversation = conversations.find((item) => item.id === conversationId) ?? null

  const applyProjectLayout = useCallback((nextProjectId: string) => {
    const layout = readProjectLayout(nextProjectId)
    setSessionSidebarWidth(layout.sessionSidebarWidth)
    setContextWidth(layout.contextWidth)
    setTerminalHeight(layout.terminalHeight)
    setSessionSidebarOpen(layout.sessionSidebarOpen)
    setContextOpen(layout.contextOpen)
    setTerminalOpen(layout.terminalOpen)
  }, [])

  useEffect(() => {
    let current = true
    Promise.all([api.listProjects(), api.listAgents()])
      .then(([nextProjects, nextAgents]) => {
        if (!current) return
        setProjects(nextProjects)
        setAgents(nextAgents)
        const initialProjectId = nextProjects[0]?.id ?? null
        setProjectId(initialProjectId)
        if (initialProjectId) applyProjectLayout(initialProjectId)
      })
      .catch((cause: unknown) => setError(errorMessage(cause, t('kubecode.error'))))
    return () => { current = false }
  }, [api, applyProjectLayout, t])

  useEffect(() => {
    if (!projectId) return
    let current = true
    Promise.all([api.listTerminals(projectId), api.listConversations(projectId)])
      .then(([nextTerminals, nextConversations]) => {
        if (!current) return
        setTerminals(nextTerminals)
        setConversations(nextConversations)
        setConversationId((selected) => (
          nextConversations.some((item) => item.id === selected)
            ? selected
            : nextConversations.at(-1)?.id ?? null
        ))
      })
      .catch((cause: unknown) => setError(errorMessage(cause, t('kubecode.error'))))
    return () => { current = false }
  }, [api, projectId, t])

  useEffect(() => {
    if (!projectId) return
    writeProjectLayout(projectId, {
      contextOpen,
      contextWidth,
      sessionSidebarOpen,
      sessionSidebarWidth,
      terminalHeight,
      terminalOpen,
    })
  }, [contextOpen, contextWidth, projectId, sessionSidebarOpen, sessionSidebarWidth, terminalHeight, terminalOpen])

  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    const stream = new EventSource(api.workspaceEventStreamUrl())
    const receive = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as WorkspaceEvent
      setWorkspaceEvent(event)
      if (event.kind === 'session_created' && event.project_id === projectId && projectId) {
        void api.listConversations(projectId).then(setConversations)
      }
    }
    stream.addEventListener('workspace_event', receive as EventListener)
    stream.onerror = () => setError(t('kubecode.connectionLost'))
    return () => stream.close()
  }, [api, projectId, t])

  const resizeSessionSidebar = useCallback((delta: number) => {
    setSessionSidebarWidth((current) => clamp(current + delta, 120, availableWidth(workspaceRef.current) - 420))
  }, [])

  const resizeContext = useCallback((delta: number) => {
    setContextWidth((current) => clamp(current - delta, 160, availableWidth(workspaceRef.current) - 320))
  }, [])

  const resizeTerminal = useCallback((delta: number) => {
    const height = mainStackRef.current?.clientHeight || window.innerHeight - 40
    setTerminalHeight((current) => clamp(current - delta, 36, height - 100))
  }, [])

  const selectProject = (nextProjectId: string) => {
    setConversationId(null)
    setConversations([])
    setTerminals([])
    applyProjectLayout(nextProjectId)
    setProjectId(nextProjectId)
  }

  return (
    <main className="kubecode-app">
      <header className="kubecode-topbar">
        <div className="kubecode-history-controls">
          <Button aria-label={t('kubecode.toggleSessions')} size="icon-xs" variant="ghost" onClick={() => setSessionSidebarOpen((open) => !open)}>
            <SidebarSimple />
          </Button>
          <Button aria-label={t('kubecode.back')} disabled size="icon-xs" variant="ghost"><ArrowLeft /></Button>
          <Button aria-label={t('kubecode.forward')} disabled size="icon-xs" variant="ghost"><ArrowRight /></Button>
        </div>
        <div className="kubecode-search">
          <MagnifyingGlass />
          <Input aria-label={t('kubecode.search')} placeholder={`${t('kubecode.search')} ${project?.name ?? ''}`.trim()} />
          <kbd>⌘K</kbd>
        </div>
        <div className="kubecode-topbar-actions">
          {error && <span className="kubecode-topbar-error" title={error}>!</span>}
          <Button aria-label={t('kubecode.toggleTerminal')} size="icon-xs" variant={terminalOpen ? 'secondary' : 'ghost'} onClick={() => setTerminalOpen((open) => !open)}>
            <TerminalWindow />
          </Button>
          <Button aria-label={t('kubecode.toggleContext')} size="icon-xs" variant={contextOpen ? 'secondary' : 'ghost'} onClick={() => setContextOpen((open) => !open)}>
            <SidebarSimple className="scale-x-[-1]" />
          </Button>
        </div>
      </header>

      <div className="kubecode-workspace" ref={workspaceRef}>
        <nav className="kubecode-project-rail" aria-label={t('kubecode.projects')}>
          <div className="kubecode-project-rail-list">
            {projects.map((item) => (
              <Button
                aria-label={item.name}
                className="kubecode-project-button"
                data-active={item.id === projectId}
                key={item.id}
                size="icon"
                variant="ghost"
                onClick={() => selectProject(item.id)}
              >
                {projectInitial(item.name)}
              </Button>
            ))}
            <Button aria-label={t('kubecode.addProject')} size="icon-sm" variant="ghost" onClick={() => setProjectDialog(true)}><Plus /></Button>
          </div>
          <div className="kubecode-project-rail-footer">
            <Button aria-label={t('kubecode.settings')} size="icon-sm" variant="ghost" onClick={() => setSettingsOpen(true)}><Gear /></Button>
            <Button aria-label={t('kubecode.help')} size="icon-sm" variant="ghost"><Question /></Button>
          </div>
        </nav>

        {sessionSidebarOpen && (
          <>
            <aside className="kubecode-session-sidebar" style={{ width: sessionSidebarWidth }}>
              <div className="kubecode-project-heading">
                <div>
                  <strong>{project?.name ?? t('kubecode.appName')}</strong>
                  <span>{project?.path ?? t('kubecode.selectProject')}</span>
                </div>
                <Button aria-label={t('kubecode.collapse')} size="icon-xs" variant="ghost" onClick={() => setSessionSidebarOpen(false)}><CaretLeft /></Button>
              </div>
              <Button className="kubecode-new-session" disabled={!projectId} variant="outline" onClick={() => setSessionDialog(true)}>
                <Plus /> {t('kubecode.newSession')}
              </Button>
              <div className="kubecode-session-list">
                {conversations.map((item) => (
                  <Button
                    className="kubecode-session-row"
                    key={item.id}
                    variant={item.id === conversationId ? 'secondary' : 'ghost'}
                    onClick={() => setConversationId(item.id)}
                  >
                    <AiAgentIcon agent={item.agent_id} size={15} />
                    <span>{item.title}</span>
                  </Button>
                ))}
                {projectId && conversations.length === 0 && (
                  <div className="kubecode-empty-small">{t('kubecode.noSessions')}</div>
                )}
              </div>
            </aside>
            <ResizeHandle onResize={resizeSessionSidebar} />
          </>
        )}

        <div className="kubecode-main-stack" ref={mainStackRef}>
          <div className="kubecode-session-context-row">
            <AgentSessionWorkspace
              agents={agents}
              api={api}
              conversation={conversation}
              locale={locale}
              projectId={projectId}
              t={t}
              workspaceEvent={workspaceEvent}
              key={conversationId ?? projectId ?? 'no-project'}
            />
            {contextOpen && (
              <>
                <ResizeHandle onResize={resizeContext} />
                <ContextWorkbench
                  api={api}
                  key={projectId}
                  projectId={projectId}
                  t={t}
                  width={contextWidth}
                  workspaceEvent={workspaceEvent}
                />
              </>
            )}
          </div>
          {terminalOpen && (
            <>
              <ResizeHandle direction="vertical" onResize={resizeTerminal} />
              <div className="kubecode-terminal-pane" style={{ height: terminalHeight }}>
                {projectId ? (
                  <TerminalWorkspace agents={agents} api={api} initialTerminals={terminals} key={projectId} projectId={projectId} t={t} />
                ) : (
                  <div className="kubecode-empty-small">{t('kubecode.selectProject')}</div>
                )}
              </div>
            </>
          )}
        </div>
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
      <NewSessionDialog
        agents={agents}
        api={api}
        open={sessionDialog}
        projectId={projectId}
        onOpenChange={setSessionDialog}
        onSession={(created) => {
          setConversations((current) => [...current, created])
          setConversationId(created.id)
        }}
        t={t}
      />
      <KubecodeSettingsDialog agents={agents} open={settingsOpen} onOpenChange={setSettingsOpen} t={t} />
    </main>
  )
}

type Translator = ReturnType<typeof createTranslator>

function NewSessionDialog({
  agents,
  api,
  open,
  projectId,
  onOpenChange,
  onSession,
  t,
}: {
  agents: AgentDescriptor[]
  api: KubecodeApi
  open: boolean
  projectId: string | null
  onOpenChange: (open: boolean) => void
  onSession: (conversation: Conversation) => void
  t: Translator
}) {
  const availableAgent = agents.find((agent) => agent.available)
  const [agentId, setAgentId] = useState<AgentId>(availableAgent?.id ?? 'codex')
  const [title, setTitle] = useState('')

  const selectedAgentId = agents.some((agent) => agent.id === agentId && agent.available)
    ? agentId
    : availableAgent?.id ?? agentId

  const create = async () => {
    if (!projectId) return
    const session = await api.createConversation(projectId, selectedAgentId, title.trim() || undefined)
    trackEvent('kubecode_session_created', { agent_id: selectedAgentId })
    setTitle('')
    onSession(session)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('kubecode.newSession')}</DialogTitle>
          <DialogDescription>{t('kubecode.newSessionDescription')}</DialogDescription>
        </DialogHeader>
        <Input aria-label={t('kubecode.sessionTitle')} placeholder={t('kubecode.sessionTitle')} value={title} onChange={(event) => setTitle(event.target.value)} />
        <Select value={selectedAgentId} onValueChange={(value) => setAgentId(value as AgentId)}>
          <SelectTrigger aria-label={t('kubecode.agent')}><SelectValue /></SelectTrigger>
          <SelectContent>
            {agents.map((agent) => (
              <SelectItem disabled={!agent.available} key={agent.id} value={agent.id}>
                <AiAgentIcon agent={agent.id} size={15} /> {agentName(agent.id)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">{t('kubecode.cancel')}</Button></DialogClose>
          <Button disabled={!projectId || !availableAgent} onClick={() => void create()}>{t('kubecode.create')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

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
          <Button variant={mode === 'create' ? 'default' : 'outline'} onClick={() => setMode('create')}>{t('kubecode.createProject')}</Button>
          <Button variant={mode === 'import' ? 'default' : 'outline'} onClick={() => setMode('import')}>{t('kubecode.importProject')}</Button>
        </div>
        {mode === 'create' && <Input aria-label={t('kubecode.projectParent')} value={parent} onChange={(event) => setParent(event.target.value)} />}
        {mode === 'import' && <Input aria-label={t('kubecode.projectPath')} value={path} onChange={(event) => setPath(event.target.value)} />}
        <Input aria-label={t('kubecode.projectName')} placeholder={t('kubecode.projectName')} value={name} onChange={(event) => setName(event.target.value)} />
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">{t('kubecode.cancel')}</Button></DialogClose>
          <Button disabled={mode === 'create' ? !name.trim() : !path.trim()} onClick={() => void submit()}>{mode === 'create' ? t('kubecode.create') : t('kubecode.import')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function KubecodeSettingsDialog({
  agents,
  open,
  onOpenChange,
  t,
}: {
  agents: AgentDescriptor[]
  open: boolean
  onOpenChange: (open: boolean) => void
  t: Translator
}) {
  const [section, setSection] = useState<'general' | 'agents' | 'terminal' | 'editor'>('general')
  const [theme, setTheme] = useState<ThemeMode>(() => readStoredThemeMode(localStorage) ?? 'system')

  const changeTheme = (nextTheme: ThemeMode) => {
    setTheme(nextTheme)
    writeStoredThemeMode(localStorage, nextTheme)
    applyThemeSelectionToDocument(document, nextTheme)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="kubecode-settings-dialog">
        <DialogHeader className="sr-only">
          <DialogTitle>{t('kubecode.settings')}</DialogTitle>
          <DialogDescription>{t('kubecode.settingsDescription')}</DialogDescription>
        </DialogHeader>
        <aside className="kubecode-settings-nav">
          <strong>{t('kubecode.settings')}</strong>
          {(['general', 'agents', 'terminal', 'editor'] as const).map((item) => (
            <Button key={item} variant={section === item ? 'secondary' : 'ghost'} onClick={() => setSection(item)}>
              {t(`kubecode.settings.${item}`)}
            </Button>
          ))}
        </aside>
        <section className="kubecode-settings-content">
          <h2>{t(`kubecode.settings.${section}`)}</h2>
          {section === 'general' && (
            <div className="kubecode-setting-row">
              <div><strong>{t('kubecode.theme')}</strong><span>{t('kubecode.themeDescription')}</span></div>
              <Select value={theme} onValueChange={(value) => changeTheme(value as ThemeMode)}>
                <SelectTrigger aria-label={t('kubecode.theme')} className="w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">{t('kubecode.theme.system')}</SelectItem>
                  <SelectItem value="light">{t('kubecode.theme.light')}</SelectItem>
                  <SelectItem value="dark">{t('kubecode.theme.dark')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {section === 'agents' && agents.map((agent) => (
            <div className="kubecode-setting-row" key={agent.id}>
              <div><strong><AiAgentIcon agent={agent.id} size={15} /> {agentName(agent.id)}</strong><span>{agent.executable}</span></div>
              <span data-available={agent.available}>{agent.available ? agent.version ?? t('kubecode.ready') : t('kubecode.unavailable')}</span>
            </div>
          ))}
          {(section === 'terminal' || section === 'editor') && <div className="kubecode-settings-placeholder">{t('kubecode.settingsComingSoon')}</div>}
        </section>
      </DialogContent>
    </Dialog>
  )
}

function agentName(id: AgentId): string {
  if (id === 'claude_code') return 'Claude Code'
  if (id === 'opencode') return 'OpenCode'
  return 'Codex'
}

function projectInitial(name: string): string {
  return [...name.trim()][0]?.toUpperCase() ?? 'P'
}

function availableWidth(element: HTMLElement | null): number {
  return element?.clientWidth || window.innerWidth
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(minimum, maximum), Math.max(minimum, value))
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

type ProjectLayout = {
  contextOpen: boolean
  contextWidth: number
  sessionSidebarOpen: boolean
  sessionSidebarWidth: number
  terminalHeight: number
  terminalOpen: boolean
}

const DEFAULT_PROJECT_LAYOUT: ProjectLayout = {
  contextOpen: true,
  contextWidth: 440,
  sessionSidebarOpen: true,
  sessionSidebarWidth: 280,
  terminalHeight: 260,
  terminalOpen: true,
}

function readProjectLayout(projectId: string): ProjectLayout {
  try {
    const stored = JSON.parse(localStorage.getItem(`kubecode:layout:${projectId}`) ?? '{}') as Partial<ProjectLayout>
    return {
      contextOpen: booleanValue(stored.contextOpen, DEFAULT_PROJECT_LAYOUT.contextOpen),
      contextWidth: numericValue(stored.contextWidth, DEFAULT_PROJECT_LAYOUT.contextWidth),
      sessionSidebarOpen: booleanValue(stored.sessionSidebarOpen, DEFAULT_PROJECT_LAYOUT.sessionSidebarOpen),
      sessionSidebarWidth: numericValue(stored.sessionSidebarWidth, DEFAULT_PROJECT_LAYOUT.sessionSidebarWidth),
      terminalHeight: numericValue(stored.terminalHeight, DEFAULT_PROJECT_LAYOUT.terminalHeight),
      terminalOpen: booleanValue(stored.terminalOpen, DEFAULT_PROJECT_LAYOUT.terminalOpen),
    }
  } catch {
    return DEFAULT_PROJECT_LAYOUT
  }
}

function writeProjectLayout(projectId: string, layout: ProjectLayout): void {
  try {
    localStorage.setItem(`kubecode:layout:${projectId}`, JSON.stringify(layout))
  } catch {
    // Restricted browser contexts can disable local storage.
  }
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function numericValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
