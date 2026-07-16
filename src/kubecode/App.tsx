import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bell,
  DotsThree,
  Folder,
  Gear,
  MagnifyingGlass,
  Plus,
  Question,
  WarningCircle,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { createTranslator, resolveEffectiveLocale } from '@/lib/i18n'
import { trackEvent } from '@/lib/telemetry'

import { AgentSessionWorkspace } from './AgentSessionWorkspace'
import { ContextWorkbench } from './ContextWorkbench'
import { DisableWorkspacesDialog } from './DisableWorkspacesDialog'
import {
  applyKubecodeAppearance,
  KUBECODE_THEME_OPTIONS,
  readKubecodeAppearance,
  terminalFontStack,
  writeKubecodeAppearance,
  type KubecodeAppearance,
  type KubecodeTheme,
} from './appearancePreferences'
import { KubecodeApi } from './api'
import type {
  AgentDescriptor,
  AgentId,
  AgentRun,
  Conversation,
  DirectoryListing,
  Project,
  ProviderSessionInfo,
  RunStatus,
  TerminalInfo,
  TeamSnapshot,
  WorkspaceEvent,
} from './api'
import { TerminalWorkspace } from './TerminalWorkspace'
import { SessionSidebarList } from './SessionSidebarList'
import { SystemMessageNotice, SystemMessageProvider } from './SystemMessageNotice'
import {
  readKubecodeNotifications,
  writeKubecodeNotifications,
  type KubecodeNotifications,
  type NotificationCategory,
} from './notificationPreferences'
import { WorkspaceNotificationBridge } from './WorkspaceNotificationBridge'
import {
  deliverBrowserNotification,
  ensureBrowserNotificationPermission,
  notificationPermission,
  type BrowserNotificationDelivery,
  type BrowserNotificationPermission,
} from './workspaceNotifications'
import './kubecode.css'

const browserApi = new KubecodeApi()

export function KubecodeApp({ api = browserApi }: { api?: KubecodeApi }) {
  const locale = useMemo(() => resolveEffectiveLocale(null), [])
  const t = useMemo(() => createTranslator(locale), [locale])
  const [projects, setProjects] = useState<Project[]>([])
  const [agents, setAgents] = useState<AgentDescriptor[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [terminals, setTerminals] = useState<TerminalInfo[]>([])
  const [terminalsLoadedForProjectId, setTerminalsLoadedForProjectId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [teams, setTeams] = useState<TeamSnapshot[]>([])
  const [allConversations, setAllConversations] = useState<Conversation[]>([])
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [projectDialog, setProjectDialog] = useState(false)
  const [sessionDialog, setSessionDialog] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [disableWorkspacesOpen, setDisableWorkspacesOpen] = useState(false)
  const [sessionSidebarOpen, setSessionSidebarOpen] = useState(true)
  const [contextOpen, setContextOpen] = useState(true)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connectionLost, setConnectionLost] = useState(false)
  const [workspaceEvents, setWorkspaceEvents] = useState<WorkspaceEvent[]>([])
  const [workspaceCursor, setWorkspaceCursor] = useState<number | null>(null)
  const [projectRuns, setProjectRuns] = useState<Record<string, AgentRun[]>>({})
  const [notifications, setNotifications] = useState<KubecodeNotifications>(() => (
    readKubecodeNotifications(localStorage)
  ))
  const [notificationOnboardingSuppressed, setNotificationOnboardingSuppressed] = useState(false)
  const [browserPermission, setBrowserPermission] = useState<BrowserNotificationPermission>(() => (
    notificationPermission()
  ))
  const [notificationTestStatus, setNotificationTestStatus] = useState<BrowserNotificationDelivery['status'] | null>(null)
  const [sessionSidebarWidth, setSessionSidebarWidth] = useState(280)
  const [contextWidth, setContextWidth] = useState(440)
  const [terminalHeight, setTerminalHeight] = useState(260)
  const [appearance, setAppearance] = useState<KubecodeAppearance>(() => (
    readKubecodeAppearance(localStorage)
  ))
  const workspaceRef = useRef<HTMLDivElement>(null)
  const mainStackRef = useRef<HTMLDivElement>(null)
  const activeProjectIdRef = useRef(projectId)
  const project = projects.find((item) => item.id === projectId) ?? null
  const conversation = conversations.find((item) => item.id === conversationId) ?? null
  const activeTeam = teams.find((team) => (
    team.members.some((member) => member.conversation_id === conversationId)
  )) ?? null
  const sessionCatalog = useMemo(
    () => mergeConversations(allConversations, conversations),
    [allConversations, conversations],
  )
  const attentionSessions = useMemo(
    () => sessionsRequiringInput(projectRuns, sessionCatalog),
    [projectRuns, sessionCatalog],
  )
  const notificationOnboardingOpen = !notificationOnboardingSuppressed
    && !notifications.onboardingDismissed
    && browserPermission === 'default'
    && workspaceEvents.some((event) => event.kind === 'run_started')

  useEffect(() => {
    applyKubecodeAppearance(document, appearance)
    writeKubecodeAppearance(localStorage, appearance)
    if (appearance.colorScheme !== 'system' || typeof window.matchMedia !== 'function') return
    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
    const applySystemTheme = () => applyKubecodeAppearance(document, appearance)
    systemTheme.addEventListener('change', applySystemTheme)
    return () => systemTheme.removeEventListener('change', applySystemTheme)
  }, [appearance])

  useEffect(() => {
    writeKubecodeNotifications(localStorage, notifications)
  }, [notifications])

  useEffect(() => {
    activeProjectIdRef.current = projectId
  }, [projectId])

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
        if (typeof api.listProjectRuns === 'function') {
          void Promise.all(nextProjects.map(async (item) => (
            [item.id, await api.listProjectRuns(item.id)] as const
          ))).then((entries) => {
            if (!current) return
            setProjectRuns((existing) => mergeProjectRuns(existing, Object.fromEntries(entries)))
          }).catch((cause: unknown) => setError(errorMessage(cause, t('kubecode.error'))))
        }
      })
      .catch((cause: unknown) => setError(errorMessage(cause, t('kubecode.error'))))
    return () => { current = false }
  }, [api, applyProjectLayout, t])

  useEffect(() => {
    let current = true
    const sessions = typeof api.listSessions === 'function'
      ? api.listSessions()
      : Promise.resolve<Conversation[]>([])
    const cursor = typeof api.workspaceEventCursor === 'function'
      ? api.workspaceEventCursor()
      : Promise.resolve(0)
    void Promise.all([sessions, cursor])
      .then(([nextConversations, nextCursor]) => {
        if (!current) return
        setAllConversations(nextConversations)
        setWorkspaceCursor(nextCursor)
      })
      .catch((cause: unknown) => {
        if (!current) return
        setWorkspaceCursor(0)
        setError(errorMessage(cause, t('kubecode.error')))
      })
    return () => { current = false }
  }, [api, t])

  useEffect(() => {
    if (!projectId) return
    let current = true
    const nextTeams = typeof api.listTeams === 'function' ? api.listTeams(projectId) : Promise.resolve([])
    Promise.all([api.listTerminals(projectId), api.listConversations(projectId), nextTeams])
      .then(([nextTerminals, nextConversations, projectTeams]) => {
        if (!current) return
        setTerminals(nextTerminals)
        setTerminalsLoadedForProjectId(projectId)
        setConversations(nextConversations)
        setTeams(projectTeams)
        setAllConversations((current) => mergeConversations(current, nextConversations))
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
    if (!projectId || teams.length === 0) return
    const timer = window.setInterval(() => {
      void api.listTeams(projectId).then(setTeams).catch(() => undefined)
    }, 3000)
    return () => window.clearInterval(timer)
  }, [api, projectId, teams.length])

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
    if (typeof EventSource === 'undefined' || workspaceCursor === null) return
    const stream = new EventSource(api.workspaceEventStreamUrl(workspaceCursor))
    const receive = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as WorkspaceEvent
      setWorkspaceEvents((current) => [...current, event].slice(-2048))
      setProjectRuns((current) => applyWorkspaceRunEvent(current, event))
      setAllConversations((current) => applyWorkspaceConversationEvent(current, event))
      setConversations((current) => applyWorkspaceConversationEvent(current, event))
      const activeProjectId = activeProjectIdRef.current
      if (['session_created', 'session_imported', 'session_updated', 'session_removed'].includes(event.kind)) {
        if (typeof api.listSessions === 'function') void api.listSessions().then(setAllConversations)
        if (event.project_id === activeProjectId && activeProjectId) {
          void api.listConversations(activeProjectId).then(setConversations)
        }
      }
      if (isCleanTerminalExit(event)) {
        const terminalId = event.payload.terminal_id
        if (typeof terminalId === 'string') {
          void api.closeTerminal(terminalId)
            .then(() => trackEvent('kubecode_terminal_auto_closed', { reason: 'clean_exit' }))
            .then(() => event.project_id === activeProjectId && activeProjectId
              ? api.listTerminals(activeProjectId).then(setTerminals)
              : undefined)
            .catch((cause: unknown) => {
              setError(errorMessage(cause, t('kubecode.error')))
              return event.project_id === activeProjectId && activeProjectId
                ? api.listTerminals(activeProjectId).then(setTerminals)
                : undefined
            })
        }
        return
      }
      if (['terminal_created', 'terminal_updated', 'terminal_exited', 'terminal_closed'].includes(event.kind)
        && event.project_id === activeProjectId && activeProjectId) {
        void api.listTerminals(activeProjectId).then(setTerminals)
      }
    }
    stream.addEventListener('workspace_event', receive as EventListener)
    stream.onopen = () => setConnectionLost(false)
    stream.onerror = () => setConnectionLost(true)
    return () => stream.close()
  }, [api, t, workspaceCursor])

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
    setTeams([])
    setTerminals([])
    setTerminalsLoadedForProjectId(null)
    applyProjectLayout(nextProjectId)
    setProjectId(nextProjectId)
  }

  const deleteProject = async () => {
    if (!project) return
    try {
      await api.unregisterProject(project.id)
      const remainingProjects = projects.filter((item) => item.id !== project.id)
      const nextProjectId = remainingProjects[0]?.id ?? null
      setProjects(remainingProjects)
      setProjectRuns((current) => {
        const next = { ...current }
        delete next[project.id]
        return next
      })
      setConversations([])
      setTeams([])
      setAllConversations((current) => current.filter((item) => item.project_id !== project.id))
      setConversationId(null)
      setTerminals([])
      setTerminalsLoadedForProjectId(null)
      if (nextProjectId) applyProjectLayout(nextProjectId)
      setProjectId(nextProjectId)
      trackEvent('kubecode_project_removed')
    } catch (cause) {
      setError(errorMessage(cause, t('kubecode.error')))
    }
  }

  const setProjectWorkspacesEnabled = async (enabled: boolean) => {
    if (!project) return
    if (!enabled) {
      setDisableWorkspacesOpen(true)
      return
    }
    try {
      const updated = await api.setProjectWorkspacesEnabled(project.id, enabled)
      setProjects((current) => current.map((item) => item.id === updated.id ? updated : item))
      trackEvent('kubecode_project_workspaces_changed', { enabled: Number(enabled) })
    } catch (cause) {
      setError(errorMessage(cause, t('kubecode.error')))
    }
  }

  const handleConversationCreated = useCallback((created: Conversation) => {
    setConversations((current) => upsertConversation(current, created))
    setAllConversations((current) => upsertConversation(current, created))
    setConversationId(created.id)
  }, [])

  const handleConversationRemoved = useCallback((removedId: string) => {
    setConversations((current) => {
      const next = current.filter((item) => item.id !== removedId)
      setConversationId((selected) => selected === removedId ? next.at(-1)?.id ?? null : selected)
      return next
    })
    setAllConversations((current) => current.filter((item) => item.id !== removedId))
  }, [])

  const handleConversationUpdated = useCallback((updated: Conversation) => {
    setConversations((current) => upsertConversation(current, updated))
    setAllConversations((current) => upsertConversation(current, updated))
  }, [])

  const openSession = useCallback((nextProjectId: string, nextConversationId: string) => {
    if (nextProjectId !== projectId) {
      applyProjectLayout(nextProjectId)
      setTerminals([])
      setTerminalsLoadedForProjectId(null)
      setConversations([])
      setProjectId(nextProjectId)
    }
    setConversationId(nextConversationId)
  }, [applyProjectLayout, projectId])

  const requestNotificationPermission = useCallback(async () => {
    const permission = await ensureBrowserNotificationPermission()
    setBrowserPermission(permission)
    if (permission !== 'granted') {
      setNotificationTestStatus(permission === 'unsupported' ? 'unsupported' : 'permission_required')
    }
    setNotifications((current) => ({ ...current, onboardingDismissed: true }))
    setNotificationOnboardingSuppressed(true)
    trackEvent('kubecode_notification_permission_requested', { result: permission })
  }, [])

  const dismissNotificationOnboarding = useCallback(() => {
    setNotifications((current) => ({ ...current, onboardingDismissed: true }))
    setNotificationOnboardingSuppressed(true)
    trackEvent('kubecode_notification_onboarding_dismissed')
  }, [])

  const sendTestNotification = useCallback(async () => {
    const permission = await ensureBrowserNotificationPermission()
    setBrowserPermission(permission)
    if (permission !== 'granted') {
      setNotificationTestStatus(permission === 'unsupported' ? 'unsupported' : 'permission_required')
      return
    }
    const delivery = deliverBrowserNotification(t('kubecode.notificationTestTitle'), {
      body: t('kubecode.notificationTestBody'),
      silent: notifications.sound.completion === 'none',
      tag: 'kubecode:test',
    })
    setNotificationTestStatus(delivery.status)
    trackEvent('kubecode_notification_tested', { result: delivery.status })
  }, [notifications.sound.completion, t])

  return (
    <SystemMessageProvider dismissLabel={t('window.close')}>
      <main className="kubecode-app">
      <header className="kubecode-topbar">
        <div className="kubecode-history-controls">
          <Button aria-label={t('kubecode.back')} disabled size="icon-xs" variant="ghost"><ArrowLeft /></Button>
          <Button aria-label={t('kubecode.forward')} disabled size="icon-xs" variant="ghost"><ArrowRight /></Button>
        </div>
        <div className="kubecode-search">
          <MagnifyingGlass />
          <Input aria-label={t('kubecode.search')} placeholder={`${t('kubecode.search')} ${project?.name ?? ''}`.trim()} />
          <kbd>⌘K</kbd>
        </div>
        <div className="kubecode-topbar-actions">
          {(error || connectionLost) && (
            <span
              aria-label={error ?? t('kubecode.connectionLost')}
              className="kubecode-topbar-error"
              role="status"
              title={error ?? t('kubecode.connectionLost')}
            >
              <WarningCircle weight="fill" />
            </span>
          )}
          {attentionSessions.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label={t('kubecode.sessionsRequireInput', { count: attentionSessions.length })}
                  className="kubecode-attention-trigger"
                  size="sm"
                  variant="ghost"
                >
                  <Bell weight="fill" />
                  <span>{attentionSessions.length}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="kubecode-attention-menu">
                {attentionSessions.map((item) => (
                  <DropdownMenuItem
                    key={item.id}
                    onSelect={() => openSession(item.project_id, item.id)}
                  >
                    <AiAgentIcon agent={item.agent_id} size={18} />
                    <span>
                      <strong>{item.title || t('kubecode.untitledSession')}</strong>
                      <small>{projects.find((projectItem) => projectItem.id === item.project_id)?.name}</small>
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button aria-label={t('kubecode.toggleSessions')} aria-pressed={sessionSidebarOpen} className="kubecode-layout-toggle" size="icon-xs" variant="ghost" onClick={() => setSessionSidebarOpen((open) => togglePanel('sessions', open))}>
            <PanelToggleIcon active={sessionSidebarOpen} panel="left" />
          </Button>
          <Button aria-label={t('kubecode.toggleTerminal')} aria-pressed={terminalOpen} className="kubecode-layout-toggle" size="icon-xs" variant="ghost" onClick={() => setTerminalOpen((open) => togglePanel('terminal', open))}>
            <PanelToggleIcon active={terminalOpen} panel="bottom" />
          </Button>
          <Button aria-label={t('kubecode.toggleContext')} aria-pressed={contextOpen} className="kubecode-layout-toggle" size="icon-xs" variant="ghost" onClick={() => setContextOpen((open) => togglePanel('context', open))}>
            <PanelToggleIcon active={contextOpen} panel="right" />
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
                data-session-status={projectSessionStatus(projectRuns[item.id] ?? []) ?? undefined}
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
                  {project?.workspaces_enabled && <small>{t('kubecode.workspacesEnabled')}</small>}
                </div>
                {project && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button aria-label={t('kubecode.projectActions')} size="icon-xs" variant="ghost">
                        <DotsThree />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => void setProjectWorkspacesEnabled(!project.workspaces_enabled)}>
                        {project.workspaces_enabled
                          ? t('kubecode.disableWorkspaces')
                          : t('kubecode.enableWorkspaces')}
                      </DropdownMenuItem>
                      <DropdownMenuItem variant="destructive" onSelect={() => void deleteProject()}>
                        {t('kubecode.delete')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
              <Button className="kubecode-new-session" disabled={!projectId} variant="outline" onClick={() => setSessionDialog(true)}>
                <Plus /> {t('kubecode.newSession')}
              </Button>
              <SessionSidebarList
                activeConversationId={conversationId}
                api={api}
                conversations={conversations}
                onConversationCreated={handleConversationCreated}
                onConversationRemoved={handleConversationRemoved}
                onConversationUpdated={handleConversationUpdated}
                onError={(cause) => setError(errorMessage(cause, t('kubecode.error')))}
                onSelect={setConversationId}
                t={t}
                teams={teams}
              />
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
              onConversationCreated={handleConversationCreated}
              projectId={projectId}
              onConversationRemoved={handleConversationRemoved}
              onConversationUpdated={handleConversationUpdated}
              onTeamCreated={(team) => setTeams((current) => [
                ...current.filter((item) => item.team.id !== team.team.id),
                team,
              ])}
              t={t}
              team={activeTeam}
              onSelectTeamMember={setConversationId}
              workspaceEvents={workspaceEvents}
              key={conversationId ?? projectId ?? 'no-project'}
            />
            {contextOpen && (
              <>
                <ResizeHandle onResize={resizeContext} />
                <ContextWorkbench
                  api={api}
                  key={projectId}
                  projectName={project?.name ?? undefined}
                  projectId={projectId}
                  t={t}
                  width={contextWidth}
                  workspaceEvents={workspaceEvents}
                />
              </>
            )}
          </div>
          {terminalOpen && <ResizeHandle direction="vertical" onResize={resizeTerminal} />}
          <div
            aria-hidden={!terminalOpen}
            className="kubecode-terminal-pane"
            data-open={terminalOpen}
            inert={!terminalOpen ? true : undefined}
            style={{ height: terminalOpen ? terminalHeight : 0 }}
          >
            {projectId ? (
              <TerminalWorkspace
                agents={agents}
                api={api}
                autoCreateOnOpen={terminalsLoadedForProjectId === projectId && terminals.length === 0}
                initialTerminals={terminals}
                key={projectId}
                onCollapse={() => setTerminalOpen(false)}
                open={terminalOpen}
                projectId={projectId}
                t={t}
                terminalFont={terminalFontStack(appearance.terminalFont)}
              />
            ) : terminalOpen ? (
              <div className="kubecode-empty-small">{t('kubecode.selectProject')}</div>
            ) : null}
          </div>
        </div>
      </div>

      <WorkspaceNotificationBridge
        conversations={sessionCatalog}
        copy={{
          body: (category, projectName) => notificationBody(t, category, projectName),
          untitledSession: t('kubecode.untitledSession'),
        }}
        events={workspaceEvents}
        onOpenSession={openSession}
        preferences={notifications}
        projects={projects}
      />
      {notificationOnboardingOpen && (
        <aside className="kubecode-notification-onboarding" role="status">
          <Bell weight="fill" />
          <div>
            <strong>{t('kubecode.notificationOnboardingTitle')}</strong>
            <span>{t('kubecode.notificationOnboardingDescription')}</span>
          </div>
          <Button size="sm" onClick={() => void requestNotificationPermission()}>
            {t('kubecode.enableNotifications')}
          </Button>
          <Button size="sm" variant="ghost" onClick={dismissNotificationOnboarding}>
            {t('kubecode.notNow')}
          </Button>
        </aside>
      )}

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
      {project && (
        <DisableWorkspacesDialog
          api={api}
          onMigrated={(updated) => {
            setProjects((current) => current.map((item) => item.id === updated.id ? updated : item))
            void api.listConversations(updated.id).then((next) => {
              setConversations(next)
              setAllConversations((current) => mergeConversations(current, next))
            })
          }}
          onOpenChange={setDisableWorkspacesOpen}
          open={disableWorkspacesOpen}
          project={project}
          t={t}
        />
      )}
      <NewSessionDialog
        agents={agents}
        api={api}
        open={sessionDialog}
        project={project}
        projectId={projectId}
        onOpenChange={setSessionDialog}
        onSession={handleConversationCreated}
        onTeam={(team) => {
          setTeams((current) => [...current.filter((item) => item.team.id !== team.team.id), team])
          handleConversationCreated(team.leader_conversation)
        }}
        t={t}
      />
        <KubecodeSettingsDialog
        agents={agents}
        appearance={appearance}
        notifications={notifications}
        notificationPermission={browserPermission}
        notificationTestStatus={notificationTestStatus}
        open={settingsOpen}
        onAppearanceChange={setAppearance}
        onNotificationsChange={setNotifications}
        onOpenChange={setSettingsOpen}
        onRequestNotificationPermission={requestNotificationPermission}
        onTestNotification={sendTestNotification}
        t={t}
        />
      </main>
    </SystemMessageProvider>
  )
}

function upsertConversation(current: Conversation[], conversation: Conversation): Conversation[] {
  return [...current.filter((item) => item.id !== conversation.id), conversation]
}

function mergeConversations(...groups: Conversation[][]): Conversation[] {
  const merged = new Map<string, Conversation>()
  for (const group of groups) {
    for (const conversation of group) merged.set(conversation.id, conversation)
  }
  return [...merged.values()]
}

function sessionsRequiringInput(
  projectRuns: Record<string, AgentRun[]>,
  conversations: Conversation[],
): Conversation[] {
  const conversationsById = new Map(conversations.map((conversation) => [conversation.id, conversation]))
  const requiringInput = new Map<string, Conversation>()
  for (const runs of Object.values(projectRuns)) {
    const latestRuns = new Map<string, AgentRun>()
    for (const run of runs) latestRuns.set(run.conversation_id, run)
    for (const run of latestRuns.values()) {
      const conversation = conversationsById.get(run.conversation_id)
      if (run.status === 'waiting_permission' && conversation) requiringInput.set(conversation.id, conversation)
    }
  }
  return [...requiringInput.values()]
}

type ProjectSessionStatus = 'running' | 'stuck'

function projectSessionStatus(runs: AgentRun[]): ProjectSessionStatus | null {
  const latestRuns = new Map<string, AgentRun>()
  for (const run of runs) latestRuns.set(run.conversation_id, run)
  const statuses = [...latestRuns.values()].map((run) => run.status)
  if (statuses.some(isStuckStatus)) return 'stuck'
  return statuses.includes('running') ? 'running' : null
}

function isStuckStatus(status: RunStatus): boolean {
  return status === 'waiting_permission'
    || status === 'failed'
    || status === 'timed_out'
    || status === 'interrupted'
}

function mergeProjectRuns(
  current: Record<string, AgentRun[]>,
  loaded: Record<string, AgentRun[]>,
): Record<string, AgentRun[]> {
  const merged = { ...current }
  for (const [projectId, runs] of Object.entries(loaded)) {
    const currentById = new Map((current[projectId] ?? []).map((run) => [run.id, run]))
    merged[projectId] = runs.map((run) => currentById.get(run.id) ?? run)
    for (const run of currentById.values()) {
      if (!runs.some((loadedRun) => loadedRun.id === run.id)) merged[projectId].push(run)
    }
  }
  return merged
}

function applyWorkspaceRunEvent(
  current: Record<string, AgentRun[]>,
  event: WorkspaceEvent,
): Record<string, AgentRun[]> {
  if (!event.project_id || !event.conversation_id || !event.run_id) return current
  const status = eventRunStatus(event)
  if (!status) return current
  const projectRuns = current[event.project_id] ?? []
  const existing = projectRuns.find((run) => run.id === event.run_id)
  const updated: AgentRun = existing
    ? { ...existing, status }
    : {
        id: event.run_id,
        conversation_id: event.conversation_id,
        project_id: event.project_id,
        message: '',
        status,
        permission_mode: 'safe',
        error: null,
      }
  return {
    ...current,
    [event.project_id]: existing
      ? projectRuns.map((run) => run.id === updated.id ? updated : run)
      : [...projectRuns, updated],
  }
}

function applyWorkspaceConversationEvent(
  current: Conversation[],
  event: WorkspaceEvent,
): Conversation[] {
  if (!event.conversation_id) return current
  if (event.kind === 'session_removed') {
    return current.filter((conversation) => conversation.id !== event.conversation_id)
  }
  const status = eventRunStatus(event)
  if (!status) return current
  return current.map((conversation) => conversation.id === event.conversation_id
    ? { ...conversation, latest_run_status: status }
    : conversation)
}

function eventRunStatus(event: WorkspaceEvent): RunStatus | null {
  if (event.kind === 'run_started') return 'running'
  if (event.kind === 'permission_requested' || event.kind === 'elicitation_requested') {
    return 'waiting_permission'
  }
  if (event.kind === 'permission_resolved' || event.kind === 'elicitation_resolved') return 'running'
  if (event.kind !== 'run_completed') return null
  const status = event.payload.status
  return isRunStatus(status) ? status : 'completed'
}

function isRunStatus(value: unknown): value is RunStatus {
  return value === 'running'
    || value === 'waiting_permission'
    || value === 'completed'
    || value === 'failed'
    || value === 'cancelled'
    || value === 'timed_out'
    || value === 'interrupted'
}

type Translator = ReturnType<typeof createTranslator>

function notificationBody(
  t: Translator,
  category: NotificationCategory,
  projectName: string,
): string {
  if (category === 'attention') return t('kubecode.notificationAttentionBody', { project: projectName })
  if (category === 'error') return t('kubecode.notificationErrorBody', { project: projectName })
  return t('kubecode.notificationCompletionBody', { project: projectName })
}

function NewSessionDialog({
  agents,
  api,
  open,
  project,
  projectId,
  onOpenChange,
  onSession,
  onTeam,
  t,
}: {
  agents: AgentDescriptor[]
  api: KubecodeApi
  open: boolean
  project: Project | null
  projectId: string | null
  onOpenChange: (open: boolean) => void
  onSession: (conversation: Conversation) => void
  onTeam: (team: TeamSnapshot) => void
  t: Translator
}) {
  const availableAgent = agents.find((agent) => agent.available)
  const [agentId, setAgentId] = useState<AgentId>(availableAgent?.id ?? 'codex')
  const [title, setTitle] = useState('')
  const [mode, setMode] = useState<'new' | 'import'>('new')
  const [sessionKind, setSessionKind] = useState<'solo' | 'team'>('solo')
  const [executionMode, setExecutionMode] = useState<'shared' | 'worktree'>('shared')
  const [providerSessions, setProviderSessions] = useState<ProviderSessionInfo[]>([])
  const [providerSessionId, setProviderSessionId] = useState<string | null>(null)
  const [loadingProviderSessions, setLoadingProviderSessions] = useState(false)
  const [providerError, setProviderError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const selectedAgentId = agents.some((agent) => agent.id === agentId && agent.available)
    ? agentId
    : availableAgent?.id ?? agentId

  useEffect(() => {
    if (open) setExecutionMode(project?.workspaces_enabled ? 'worktree' : 'shared')
  }, [open, project?.workspaces_enabled])

  useEffect(() => {
    if (!open || mode !== 'import' || !projectId || !availableAgent) return
    let current = true
    queueMicrotask(() => {
      if (!current) return
      setLoadingProviderSessions(true)
      setProviderError(null)
    })
    void api.listProviderSessions(projectId, selectedAgentId)
      .then((sessions) => {
        if (!current) return
        setProviderSessions(sessions)
        setProviderSessionId((selected) => sessions.some((item) => item.session_id === selected)
          ? selected
          : sessions[0]?.session_id ?? null)
      })
      .catch((cause: unknown) => {
        if (current) setProviderError(errorMessage(cause, t('kubecode.providerSessionsLoadFailed')))
      })
      .finally(() => {
        if (current) setLoadingProviderSessions(false)
      })
    return () => { current = false }
  }, [api, availableAgent, mode, open, projectId, selectedAgentId, t])

  const create = async () => {
    if (!projectId) return
    setCreating(true)
    setCreateError(null)
    try {
      if (mode === 'new' && sessionKind === 'team') {
        const team = await api.createTeam(
          projectId,
          selectedAgentId,
          agentName(selectedAgentId),
          title.trim() || undefined,
          executionMode,
        )
        trackEvent('kubecode_team_created', {
          leader_agent_id: selectedAgentId,
          execution_mode: executionMode,
        })
        setTitle('')
        onTeam(team)
        onOpenChange(false)
        return
      }
      const providerSession = providerSessions.find((item) => item.session_id === providerSessionId)
      const session = await api.createConversation(
        projectId,
        selectedAgentId,
        title.trim() || undefined,
        mode === 'import' ? providerSession?.session_id : undefined,
        mode === 'import' ? providerSession?.title ?? undefined : undefined,
        mode === 'new' ? executionMode : 'shared',
      )
      trackEvent(mode === 'import' ? 'kubecode_agent_session_imported' : 'kubecode_session_created', {
        agent_id: selectedAgentId,
        execution_mode: mode === 'new' ? executionMode : 'shared',
      })
      setTitle('')
      setProviderSessionId(null)
      onSession(session)
      onOpenChange(false)
    } catch (cause) {
      setCreateError(errorMessage(cause, t('kubecode.error')))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="kubecode-new-session-dialog">
        <DialogHeader>
          <DialogTitle>{t('kubecode.newSession')}</DialogTitle>
          <DialogDescription>{t('kubecode.newSessionDescription')}</DialogDescription>
        </DialogHeader>
        <div className="kubecode-new-session-form">
          <div className="kubecode-mode-switch" role="group">
            <Button data-active={mode === 'new'} size="sm" variant="ghost" onClick={() => setMode('new')}>
              {t('kubecode.startNewSession')}
            </Button>
            <Button data-active={mode === 'import'} size="sm" variant="ghost" onClick={() => setMode('import')}>
              {t('kubecode.importAgentSession')}
            </Button>
          </div>
          {mode === 'new' && (
            <div className="kubecode-mode-switch" role="group" aria-label={t('kubecode.sessionType')}>
              <Button data-active={sessionKind === 'solo'} size="sm" variant="ghost" onClick={() => setSessionKind('solo')}>
                {t('kubecode.soloSession')}
              </Button>
              <Button data-active={sessionKind === 'team'} size="sm" variant="ghost" onClick={() => setSessionKind('team')}>
                {t('kubecode.teamSession')}
              </Button>
            </div>
          )}
          <label className="kubecode-new-session-field">
            <span>{t('kubecode.agent')}</span>
            <Select value={selectedAgentId} onValueChange={(value) => setAgentId(value as AgentId)}>
              <SelectTrigger aria-label={t('kubecode.agent')}><SelectValue /></SelectTrigger>
              <SelectContent>
                {agents.map((agent) => (
                  <SelectItem disabled={!agent.available} key={agent.id} value={agent.id}>
                    <AiAgentIcon agent={agent.id} size={18} /> {agentName(agent.id)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          {mode === 'new' ? (
            <>
              <label className="kubecode-new-session-field">
                <span>{t('kubecode.sessionTitle')}</span>
                <Input aria-label={t('kubecode.sessionTitle')} placeholder={t('kubecode.optionalSessionTitle')} value={title} onChange={(event) => setTitle(event.target.value)} />
              </label>
              {project?.workspaces_enabled && (
                <div className="kubecode-new-session-field">
                  <span>{t('kubecode.executionWorkspace')}</span>
                  <div className="kubecode-workspace-mode" role="group" aria-label={t('kubecode.executionWorkspace')}>
                    <Button data-active={executionMode === 'worktree'} variant="outline" onClick={() => setExecutionMode('worktree')}>
                      <span>{t('kubecode.newWorkspace')}</span>
                      <small>{t('kubecode.newWorkspaceDescription')}</small>
                    </Button>
                    <Button data-active={executionMode === 'shared'} variant="outline" onClick={() => setExecutionMode('shared')}>
                      <span>{t('kubecode.projectRoot')}</span>
                      <small>{t('kubecode.projectRootDescription')}</small>
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="kubecode-provider-session-list">
              {providerSessions.map((session) => (
                <Button
                  data-active={session.session_id === providerSessionId}
                  key={session.session_id}
                  variant={session.session_id === providerSessionId ? 'secondary' : 'ghost'}
                  onClick={() => setProviderSessionId(session.session_id)}
                >
                  <span>{session.title || t('kubecode.untitledSession')}</span>
                  <code>{session.updated_at ?? session.session_id}</code>
                </Button>
              ))}
              {loadingProviderSessions && <div className="kubecode-empty-small">{t('kubecode.loading')}</div>}
              {!loadingProviderSessions && providerSessions.length === 0 && !providerError && (
                <div className="kubecode-empty-small">{t('kubecode.noProviderSessions')}</div>
              )}
              {providerError && (
                <SystemMessageNotice
                  dismissLabel={t('window.close')}
                  level="error"
                  message={providerError}
                  onDismiss={() => setProviderError(null)}
                />
              )}
            </div>
          )}
          {createError && (
            <SystemMessageNotice
              dismissLabel={t('window.close')}
              level="error"
              message={createError}
              onDismiss={() => setCreateError(null)}
            />
          )}
        </div>
        <DialogFooter className="kubecode-new-session-footer">
          <DialogClose asChild><Button disabled={creating} variant="ghost">{t('kubecode.cancel')}</Button></DialogClose>
          <Button
            aria-busy={creating}
            disabled={creating || !projectId || !availableAgent || (mode === 'import' && !providerSessionId)}
            onClick={() => void create()}
          >
            {creating ? t('kubecode.loading') : mode === 'import' ? t('kubecode.import') : t('kubecode.create')}
          </Button>
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
      setPath(nextListing.path)
    } catch (cause) {
      setBrowserError(errorMessage(cause, t('kubecode.directoryLoadFailed')))
    } finally {
      setLoadingDirectories(false)
    }
  }, [api, t])

  useEffect(() => {
    if (open && mode === 'import' && !listing) void browse()
  }, [browse, listing, mode, open])

  const submit = async () => {
    const project = mode === 'create'
      ? await api.createProject(path)
      : await api.importProject(path)
    trackEvent('kubecode_project_registered', { mode })
    onProject(project)
    setPath('')
    setListing(null)
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
        {mode === 'create' ? (
          <Input
            aria-label={t('kubecode.projectPath')}
            placeholder={t('kubecode.absoluteProjectPath')}
            value={path}
            onChange={(event) => setPath(event.target.value)}
          />
        ) : (
          <div className="kubecode-directory-browser">
            <div className="kubecode-directory-location">
              <Button
                aria-label={t('kubecode.parentDirectory')}
                disabled={!listing?.parent || loadingDirectories}
                size="icon-sm"
                variant="ghost"
                onClick={() => void browse(listing?.parent ?? undefined)}
              >
                <ArrowUp />
              </Button>
              <code title={listing?.path ?? path}>{listing?.path ?? path}</code>
            </div>
            <div className="kubecode-directory-list" aria-label={t('kubecode.selectDirectory')}>
              {listing?.entries
                .filter((entry) => showHidden || !entry.hidden)
                .map((entry) => (
                  <Button key={entry.path} variant="ghost" onClick={() => void browse(entry.path)}>
                    <Folder /> <span>{entry.name}</span>
                  </Button>
                ))}
              {!loadingDirectories && listing?.entries.length === 0 && (
                <div className="kubecode-empty-small">{t('kubecode.emptyDirectory')}</div>
              )}
              {loadingDirectories && <div className="kubecode-empty-small">{t('kubecode.loading')}</div>}
            </div>
            <label className="kubecode-show-hidden">
              <Switch checked={showHidden} onCheckedChange={setShowHidden} />
              <span>{t('kubecode.showHiddenDirectories')}</span>
            </label>
            {browserError && (
              <SystemMessageNotice
                dismissLabel={t('window.close')}
                level="error"
                message={browserError}
                onDismiss={() => setBrowserError(null)}
              />
            )}
          </div>
        )}
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">{t('kubecode.cancel')}</Button></DialogClose>
          <Button disabled={!path.trim() || loadingDirectories} onClick={() => void submit()}>{mode === 'create' ? t('kubecode.create') : t('kubecode.import')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function KubecodeSettingsDialog({
  agents,
  appearance,
  notifications,
  notificationPermission: browserPermission,
  notificationTestStatus,
  open,
  onAppearanceChange,
  onNotificationsChange,
  onOpenChange,
  onRequestNotificationPermission,
  onTestNotification,
  t,
}: {
  agents: AgentDescriptor[]
  appearance: KubecodeAppearance
  notifications: KubecodeNotifications
  notificationPermission: BrowserNotificationPermission
  notificationTestStatus: BrowserNotificationDelivery['status'] | null
  open: boolean
  onAppearanceChange: (appearance: KubecodeAppearance) => void
  onNotificationsChange: (notifications: KubecodeNotifications) => void
  onOpenChange: (open: boolean) => void
  onRequestNotificationPermission: () => Promise<void>
  onTestNotification: () => Promise<void>
  t: Translator
}) {
  const [section, setSection] = useState<'general' | 'notifications' | 'agents' | 'terminal' | 'editor'>('general')

  const updateAppearance = <Key extends keyof KubecodeAppearance>(
    key: Key,
    value: KubecodeAppearance[Key],
  ) => {
    onAppearanceChange({ ...appearance, [key]: value })
    if (key === 'colorScheme' || key === 'theme') {
      trackEvent('kubecode_appearance_changed', { setting: key, value })
    }
  }

  const updateNotificationCategory = (
    category: NotificationCategory,
    enabled: boolean,
  ) => {
    onNotificationsChange({
      ...notifications,
      enabled: { ...notifications.enabled, [category]: enabled },
    })
    trackEvent('kubecode_notification_preference_changed', { category, setting: 'enabled' })
  }

  const updateNotificationSound = (
    category: NotificationCategory,
    sound: KubecodeNotifications['sound'][NotificationCategory],
  ) => {
    onNotificationsChange({
      ...notifications,
      sound: { ...notifications.sound, [category]: sound },
    })
    trackEvent('kubecode_notification_preference_changed', { category, setting: 'sound', value: sound })
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
          {(['general', 'notifications', 'agents', 'terminal', 'editor'] as const).map((item) => (
            <Button key={item} variant={section === item ? 'secondary' : 'ghost'} onClick={() => setSection(item)}>
              {t(`kubecode.settings.${item}`)}
            </Button>
          ))}
        </aside>
        <section className="kubecode-settings-content">
          <h2>{section === 'general' ? t('kubecode.appearance') : t(`kubecode.settings.${section}`)}</h2>
          {section === 'general' && (
            <div className="kubecode-settings-group">
              <div className="kubecode-setting-row">
                <div><strong>{t('kubecode.colorScheme')}</strong><span>{t('kubecode.colorSchemeDescription')}</span></div>
                <Select
                  value={appearance.colorScheme}
                  onValueChange={(value) => updateAppearance('colorScheme', value as KubecodeAppearance['colorScheme'])}
                >
                  <SelectTrigger aria-label={t('kubecode.colorScheme')} className="w-44"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="system">{t('kubecode.theme.system')}</SelectItem>
                    <SelectItem value="light">{t('kubecode.theme.light')}</SelectItem>
                    <SelectItem value="dark">{t('kubecode.theme.dark')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="kubecode-setting-row">
                <div><strong>{t('kubecode.theme')}</strong><span>{t('kubecode.themeDescription')}</span></div>
                <Select
                  value={appearance.theme}
                  onValueChange={(value) => updateAppearance('theme', value as KubecodeTheme)}
                >
                  <SelectTrigger aria-label={t('kubecode.theme')} className="w-52"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {KUBECODE_THEME_OPTIONS.map((theme) => (
                      <SelectItem key={theme} value={theme}>{t(`kubecode.theme.${theme}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="kubecode-setting-row">
                <div><strong>{t('kubecode.uiFont')}</strong><span>{t('kubecode.uiFontDescription')}</span></div>
                <Input
                  aria-label={t('kubecode.uiFont')}
                  className="kubecode-font-input"
                  value={appearance.uiFont}
                  onBlur={() => trackEvent('kubecode_appearance_changed', { setting: 'uiFont' })}
                  onChange={(event) => updateAppearance('uiFont', event.target.value)}
                />
              </div>
              <div className="kubecode-setting-row">
                <div><strong>{t('kubecode.codeFont')}</strong><span>{t('kubecode.codeFontDescription')}</span></div>
                <Input
                  aria-label={t('kubecode.codeFont')}
                  className="kubecode-font-input kubecode-font-input-mono"
                  value={appearance.codeFont}
                  onBlur={() => trackEvent('kubecode_appearance_changed', { setting: 'codeFont' })}
                  onChange={(event) => updateAppearance('codeFont', event.target.value)}
                />
              </div>
              <div className="kubecode-setting-row">
                <div><strong>{t('kubecode.terminalFont')}</strong><span>{t('kubecode.terminalFontDescription')}</span></div>
                <Input
                  aria-label={t('kubecode.terminalFont')}
                  className="kubecode-font-input kubecode-font-input-mono"
                  value={appearance.terminalFont}
                  onBlur={() => trackEvent('kubecode_appearance_changed', { setting: 'terminalFont' })}
                  onChange={(event) => updateAppearance('terminalFont', event.target.value)}
                />
              </div>
            </div>
          )}
          {section === 'notifications' && (
            <div className="kubecode-settings-group">
              <div className="kubecode-setting-row">
                <div>
                  <strong>{t('kubecode.systemNotifications')}</strong>
                  <span>{t('kubecode.systemNotificationsDescription')}</span>
                </div>
                <Select
                  value={notifications.systemMode}
                  onValueChange={(value) => {
                    onNotificationsChange({
                      ...notifications,
                      systemMode: value as KubecodeNotifications['systemMode'],
                    })
                    if (value !== 'off' && browserPermission === 'default') {
                      void onRequestNotificationPermission()
                    }
                    trackEvent('kubecode_notification_preference_changed', { setting: 'mode', value })
                  }}
                >
                  <SelectTrigger aria-label={t('kubecode.systemNotifications')} className="w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="always">{t('kubecode.notifications.always')}</SelectItem>
                    <SelectItem value="unfocused">{t('kubecode.notifications.unfocused')}</SelectItem>
                    <SelectItem value="off">{t('kubecode.notifications.off')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {(['completion', 'attention', 'error'] as const).map((category) => (
                <div className="kubecode-setting-row kubecode-notification-category" key={category}>
                  <div>
                    <strong>{t(`kubecode.notifications.${category}`)}</strong>
                    <span>{t(`kubecode.notifications.${category}Description`)}</span>
                  </div>
                  <div className="kubecode-notification-controls">
                    <Switch
                      aria-label={t(`kubecode.notifications.${category}`)}
                      checked={notifications.enabled[category]}
                      onCheckedChange={(checked) => updateNotificationCategory(category, checked)}
                    />
                    <Select
                      value={notifications.sound[category]}
                      onValueChange={(value) => updateNotificationSound(
                        category,
                        value as KubecodeNotifications['sound'][NotificationCategory],
                      )}
                    >
                      <SelectTrigger
                        aria-label={t('kubecode.notificationSound', {
                          category: t(`kubecode.notifications.${category}`),
                        })}
                        className="w-36"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="system">{t('kubecode.notifications.systemSound')}</SelectItem>
                        <SelectItem value="none">{t('kubecode.notifications.noSound')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ))}
              <div className="kubecode-setting-row">
                <div>
                  <strong>{t('kubecode.notificationPermission')}</strong>
                  <span>{t(`kubecode.notifications.permission.${browserPermission}`)}</span>
                  {notificationTestStatus && (
                    <span className="kubecode-notification-test-result" data-status={notificationTestStatus} role="status">
                      {notificationTestMessage(t, notificationTestStatus, browserPermission)}
                    </span>
                  )}
                </div>
                <div className="kubecode-notification-controls">
                  {browserPermission === 'default' && (
                    <Button size="sm" variant="outline" onClick={() => void onRequestNotificationPermission()}>
                      {t('kubecode.enableNotifications')}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void onTestNotification()}
                  >
                    {t('kubecode.testNotification')}
                  </Button>
                </div>
              </div>
            </div>
          )}
          {section === 'agents' && agents.map((agent) => (
            <div className="kubecode-setting-row" key={agent.id}>
              <div><strong><AiAgentIcon agent={agent.id} size={18} /> {agentName(agent.id)}</strong><span>{agent.executable}</span></div>
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

function notificationTestMessage(
  t: Translator,
  status: BrowserNotificationDelivery['status'],
  permission: BrowserNotificationPermission,
): string {
  if (status === 'sent') return t('kubecode.notificationTestTitle')
  if (status === 'failed') return t('kubecode.error')
  const effectivePermission = status === 'unsupported' ? 'unsupported' : permission
  return t(`kubecode.notifications.permission.${effectivePermission}`)
}

function projectInitial(name: string): string {
  return [...name.trim()][0]?.toUpperCase() ?? 'P'
}

function PanelToggleIcon({
  active,
  panel,
}: {
  active: boolean
  panel: 'left' | 'bottom' | 'right'
}) {
  return (
    <span className="kubecode-panel-toggle-icon" data-active={active} data-panel={panel}>
      <span />
    </span>
  )
}

function togglePanel(panel: 'sessions' | 'terminal' | 'context', open: boolean): boolean {
  const nextOpen = !open
  trackEvent('kubecode_panel_toggled', { next_state: nextOpen ? 'open' : 'closed', panel })
  return nextOpen
}

function isCleanTerminalExit(event: WorkspaceEvent): boolean {
  return event.kind === 'terminal_exited'
    && event.payload.exit_code === 0
    && event.payload.signal === null
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
  terminalOpen: false,
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
