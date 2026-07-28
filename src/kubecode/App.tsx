import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  ArrowUp,
  ArrowClockwise,
  Bell,
  Check,
  Copy,
  DownloadSimple,
  Eye,
  EyeSlash,
  Gear,
  MagnifyingGlass,
  Plus,
  Question,
  User,
  UsersThree,
  WarningCircle,
  IconContext,
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

import { AgentSessionWorkspace, type SessionPlanEntry } from './AgentSessionWorkspace'
import {
  readAgentPreferences,
  writeAgentPreferences,
  type KubecodeAgentPreferences,
} from './agentPreferences'
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
import { ApiError, KubecodeApi } from './api'
import { PathPicker, type PathPickerRow } from './PathPicker'
import {
  readEditorPreferences,
  writeEditorPreferences,
  type KubecodeEditorPreferences,
} from './editorPreferences'
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
  useWorkspaceEventStream,
  type WorkspaceEventBatch,
  type WorkspaceEventOwnership,
  type WorkspaceEventReconciliationRequest,
} from './useWorkspaceEventStream'
import {
  readProjectWorkbenchLayout,
  readWorkbenchNavigatorLayout,
  writeProjectWorkbenchLayout,
  writeWorkbenchNavigatorLayout,
} from './workbenchLayout'
import {
  deliverBrowserNotification,
  ensureBrowserNotificationPermission,
  notificationPermission,
  type BrowserNotificationDelivery,
  type BrowserNotificationPermission,
} from './workspaceNotifications'
import './kubecode.css'

const browserApi = new KubecodeApi()
type SettingsSection = 'general' | 'notifications' | 'agents' | 'terminal' | 'editor'

export function KubecodeApp({ api = browserApi }: { api?: KubecodeApi }) {
  const locale = useMemo(() => resolveEffectiveLocale(null), [])
  const t = useMemo(() => createTranslator(locale), [locale])
  const [projects, setProjects] = useState<Project[]>([])
  const [agents, setAgents] = useState<AgentDescriptor[]>([])
  const [agentsRefreshing, setAgentsRefreshing] = useState(false)
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
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general')
  const [disableWorkspacesOpen, setDisableWorkspacesOpen] = useState(false)
  const [sessionSidebarOpen, setSessionSidebarOpen] = useState(true)
  const [contextOpen, setContextOpen] = useState(true)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [expandedProjectIds, setExpandedProjectIds] = useState<string[]>([])
  const [navigatorQuery, setNavigatorQuery] = useState('')
  const [layoutHydrated, setLayoutHydrated] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
  const [titlebarTarget, setTitlebarTarget] = useState<HTMLDivElement | null>(null)
  const [activeSessionPlan, setActiveSessionPlan] = useState<SessionPlanEntry[]>([])
  const [planRevealVersion, setPlanRevealVersion] = useState(0)
  const [appearance, setAppearance] = useState<KubecodeAppearance>(() => (
    readKubecodeAppearance(localStorage)
  ))
  const [editorPreferences, setEditorPreferences] = useState<KubecodeEditorPreferences>(() => (
    readEditorPreferences(localStorage)
  ))
  const [agentPreferences, setAgentPreferences] = useState<KubecodeAgentPreferences>(() => (
    readAgentPreferences(localStorage)
  ))
  const narrowLayout = useNarrowWorkbench()
  const workspaceRef = useRef<HTMLDivElement>(null)
  const mainStackRef = useRef<HTMLDivElement>(null)
  const navigatorSearchRef = useRef<HTMLInputElement>(null)
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
    writeEditorPreferences(localStorage, editorPreferences)
  }, [editorPreferences])

  useEffect(() => {
    writeAgentPreferences(localStorage, agentPreferences)
  }, [agentPreferences])

  useEffect(() => {
    const focusNavigatorSearch = (event: KeyboardEvent) => {
      if (event.key.toLocaleLowerCase() !== 'k' || (!event.metaKey && !event.ctrlKey)) return
      event.preventDefault()
      navigatorSearchRef.current?.focus()
      navigatorSearchRef.current?.select()
    }
    document.addEventListener('keydown', focusNavigatorSearch)
    return () => document.removeEventListener('keydown', focusNavigatorSearch)
  }, [])

  useEffect(() => {
    writeKubecodeNotifications(localStorage, notifications)
  }, [notifications])

  useEffect(() => {
    if (!narrowLayout || (!sessionSidebarOpen && !contextOpen)) return
    const closeOverlayPanels = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('[role="dialog"]')) return
      setSessionSidebarOpen(false)
      setContextOpen(false)
    }
    document.addEventListener('keydown', closeOverlayPanels)
    return () => document.removeEventListener('keydown', closeOverlayPanels)
  }, [contextOpen, narrowLayout, sessionSidebarOpen])

  const applyProjectLayout = useCallback((nextProjectId: string) => {
    const layout = readProjectWorkbenchLayout(localStorage, nextProjectId)
    setContextWidth(layout.contextWidth)
    setTerminalHeight(layout.terminalHeight)
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
        const navigatorLayout = readWorkbenchNavigatorLayout(localStorage, initialProjectId)
        setSessionSidebarOpen(navigatorLayout.navigatorOpen)
        setSessionSidebarWidth(navigatorLayout.navigatorWidth)
        setExpandedProjectIds(navigatorLayout.expandedProjectIds)
        setLayoutHydrated(true)
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

  const refreshAgents = useCallback(async () => {
    setAgentsRefreshing(true)
    try {
      const nextAgents = typeof api.refreshAgents === 'function'
        ? await api.refreshAgents()
        : await api.listAgents()
      setAgents(nextAgents)
    } catch (cause) {
      setError(errorMessage(cause, t('kubecode.agentRefreshFailed')))
    } finally {
      setAgentsRefreshing(false)
    }
  }, [api, t])

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
    void Promise.allSettled([api.listTerminals(projectId), api.listConversations(projectId), nextTeams])
      .then(([terminalResult, conversationResult, teamResult]) => {
        if (!current) return
        if (terminalResult.status === 'fulfilled') {
          setTerminals(terminalResult.value)
          setTerminalsLoadedForProjectId(projectId)
        }
        if (conversationResult.status === 'fulfilled') {
          const nextConversations = conversationResult.value
          setConversations(nextConversations)
          setAllConversations((current) => mergeConversations(current, nextConversations))
          setConversationId((selected) => (
            nextConversations.some((item) => item.id === selected)
              ? selected
              : nextConversations.at(-1)?.id ?? null
          ))
        }
        if (teamResult.status === 'fulfilled') setTeams(teamResult.value)
        const failure = [terminalResult, conversationResult, teamResult]
          .find((result) => result.status === 'rejected')
        if (failure?.status === 'rejected') {
          setError(errorMessage(failure.reason, t('kubecode.error')))
        }
      })
    return () => { current = false }
  }, [api, projectId, t])

  useEffect(() => {
    if (!layoutHydrated) return
    writeWorkbenchNavigatorLayout(localStorage, {
      expandedProjectIds,
      navigatorOpen: sessionSidebarOpen,
      navigatorWidth: sessionSidebarWidth,
    })
  }, [expandedProjectIds, layoutHydrated, sessionSidebarOpen, sessionSidebarWidth])

  useEffect(() => {
    if (!layoutHydrated || !projectId) return
    writeProjectWorkbenchLayout(localStorage, projectId, {
      contextOpen,
      contextWidth,
      terminalHeight,
      terminalOpen,
    })
  }, [contextOpen, contextWidth, layoutHydrated, projectId, terminalHeight, terminalOpen])

  const reportOwnedError = useCallback((cause: unknown, ownership: WorkspaceEventOwnership) => {
    if (ownership.isCurrent()) setError(errorMessage(cause, t('kubecode.error')))
  }, [t])

  const handleWorkspaceEventBatch = useCallback((batch: WorkspaceEventBatch) => {
    setProjectRuns((current) => applyWorkspaceRunEvents(current, batch.events))
    setAllConversations((current) => applyWorkspaceConversationEvents(current, batch.events))
    setConversations((current) => applyWorkspaceConversationEvents(current, batch.events))
  }, [])

  const handleWorkspaceReconcile = useCallback(async (request: WorkspaceEventReconciliationRequest) => {
    const { ownership, plan } = request
    const activeProjectId = ownership.projectId
    const terminalTask = async () => {
      const closeResults = await Promise.allSettled(plan.cleanTerminalIds.map((terminalId) => (
        api.closeTerminal(terminalId).then(() => {
          trackEvent('kubecode_terminal_auto_closed', { reason: 'clean_exit' })
        })
      )))
      request.completeCleanTerminalIds(plan.cleanTerminalIds.filter(
        (_terminalId, index) => closeResults[index]?.status === 'fulfilled',
      ))
      const closeFailure = closeResults.find((result) => result.status === 'rejected')
      if (closeFailure?.status === 'rejected') throw closeFailure.reason
      return plan.refreshTerminals && activeProjectId
        ? api.listTerminals(activeProjectId)
        : undefined
    }
    const results = await Promise.allSettled([
      plan.refreshGlobalSessions && typeof api.listSessions === 'function'
        ? api.listSessions() : Promise.resolve(undefined),
      plan.refreshProjectSessions && activeProjectId
        ? api.listConversations(activeProjectId) : Promise.resolve(undefined),
      plan.refreshTeams && activeProjectId && typeof api.listTeams === 'function'
        ? api.listTeams(activeProjectId) : Promise.resolve(undefined),
      terminalTask(),
      plan.refreshProjectRuns && activeProjectId && typeof api.listProjectRuns === 'function'
        ? api.listProjectRuns(activeProjectId) : Promise.resolve(undefined),
    ])
    const failure = results.find((result) => result.status === 'rejected')
    if (failure?.status === 'rejected') {
      reportOwnedError(failure.reason, ownership)
      throw failure.reason
    }
    if (!ownership.isCurrent()) return

    const dirty = request.dirtyPlanSinceStart()
    const replayEvents = request.eventsSinceStart()
    const [sessionResult, conversationResult, teamResult, terminalResult, runResult] = results
    if (sessionResult.status === 'fulfilled' && sessionResult.value && !dirty.refreshGlobalSessions) {
      setAllConversations(applyWorkspaceConversationEvents(sessionResult.value, replayEvents))
    }
    if (conversationResult.status === 'fulfilled' && conversationResult.value
      && !dirty.refreshProjectSessions) {
      const nextConversations = applyWorkspaceConversationEvents(conversationResult.value, replayEvents)
      setConversations(nextConversations)
      setConversationId((selected) => nextConversations.some((item) => item.id === selected)
        ? selected : nextConversations.at(-1)?.id ?? null)
    }
    if (teamResult.status === 'fulfilled' && teamResult.value && !dirty.refreshTeams) {
      setTeams(teamResult.value)
    }
    if (terminalResult.status === 'fulfilled' && terminalResult.value && !dirty.refreshTerminals) {
      setTerminals(terminalResult.value)
      if (activeProjectId) setTerminalsLoadedForProjectId(activeProjectId)
    }
    if (runResult.status === 'fulfilled' && runResult.value && activeProjectId
      && !dirty.refreshProjectRuns) {
      setProjectRuns((current) => applyWorkspaceRunEvents({
        ...current,
        [activeProjectId]: runResult.value,
      }, replayEvents))
    }
  }, [api, reportOwnedError])

  const {
    connectionLost,
    diagnostic: workspaceEventDiagnostic,
    events: workspaceEvents,
  } = useWorkspaceEventStream({
    activeProjectId: projectId,
    api,
    cursor: workspaceCursor,
    onBatch: handleWorkspaceEventBatch,
    onReconcile: handleWorkspaceReconcile,
  })

  useEffect(() => {
    if (workspaceEventDiagnostic) setError(t('kubecode.error'))
  }, [t, workspaceEventDiagnostic])

  const notificationOnboardingOpen = !notificationOnboardingSuppressed
    && !notifications.onboardingDismissed
    && browserPermission === 'default'
    && workspaceEvents.some((event) => event.kind === 'run_started')

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
    setActiveSessionPlan([])
    setConversations([])
    setTeams([])
    setTerminals([])
    setTerminalsLoadedForProjectId(null)
    applyProjectLayout(nextProjectId)
    setProjectId(nextProjectId)
    setExpandedProjectIds((current) => (
      current.includes(nextProjectId) ? current : [...current, nextProjectId]
    ))
  }

  const toggleProjectExpanded = useCallback((nextProjectId: string) => {
    setExpandedProjectIds((current) => {
      const expanded = current.includes(nextProjectId)
      trackEvent('kubecode_navigator_project_toggled', {
        next_state: expanded ? 'collapsed' : 'expanded',
      })
      return expanded
        ? current.filter((candidate) => candidate !== nextProjectId)
        : [...current, nextProjectId]
    })
  }, [])

  const deleteProject = async (targetProject = project) => {
    if (!targetProject) return
    try {
      await api.unregisterProject(targetProject.id)
      const remainingProjects = projects.filter((item) => item.id !== targetProject.id)
      const nextProjectId = remainingProjects[0]?.id ?? null
      setProjects(remainingProjects)
      setProjectRuns((current) => {
        const next = { ...current }
        delete next[targetProject.id]
        return next
      })
      setConversations([])
      setTeams([])
      setAllConversations((current) => current.filter((item) => item.project_id !== targetProject.id))
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

  const setProjectWorkspacesEnabled = async (enabled: boolean, targetProject = project) => {
    if (!targetProject) return
    if (!enabled) {
      if (targetProject.id !== projectId) selectProject(targetProject.id)
      setDisableWorkspacesOpen(true)
      return
    }
    try {
      const updated = await api.setProjectWorkspacesEnabled(targetProject.id, enabled)
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
    setActiveSessionPlan([])
    if (nextProjectId !== projectId) {
      applyProjectLayout(nextProjectId)
      setTerminals([])
      setTerminalsLoadedForProjectId(null)
      setConversations([])
      setProjectId(nextProjectId)
    }
    setExpandedProjectIds((current) => (
      current.includes(nextProjectId) ? current : [...current, nextProjectId]
    ))
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
    <IconContext.Provider value={{ size: 16, weight: 'regular' }}>
      <SystemMessageProvider detailsLabel={t('kubecode.details')} dismissLabel={t('window.close')}>
      <main className="kubecode-app">
      <header className="kubecode-topbar">
        <div className="kubecode-topbar-leading">
          <div className="kubecode-titlebar-session-slot" ref={setTitlebarTarget}>
            {!conversation && (
              <span className="kubecode-titlebar-project">
                {project?.name ?? t('kubecode.appName')}
              </span>
            )}
          </div>
        </div>
        <div className="kubecode-search">
          <MagnifyingGlass />
          <Input
            aria-label={t('kubecode.searchSessions')}
            placeholder={t('kubecode.searchSessions')}
            ref={navigatorSearchRef}
            spellCheck={false}
            value={navigatorQuery}
            onChange={(event) => setNavigatorQuery(event.target.value)}
          />
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
          <Button aria-label={t('kubecode.toggleSessions')} aria-pressed={sessionSidebarOpen} className="kubecode-layout-toggle" size="icon-xs" variant="ghost" onClick={() => {
            const nextOpen = togglePanel('sessions', sessionSidebarOpen)
            setSessionSidebarOpen(nextOpen)
            if (narrowLayout && nextOpen) setContextOpen(false)
          }}>
            <PanelToggleIcon active={sessionSidebarOpen} panel="left" />
          </Button>
          <Button aria-label={t('kubecode.toggleTerminal')} aria-pressed={terminalOpen} className="kubecode-layout-toggle" size="icon-xs" variant="ghost" onClick={() => setTerminalOpen((open) => togglePanel('terminal', open))}>
            <PanelToggleIcon active={terminalOpen} panel="bottom" />
          </Button>
          <Button aria-label={t('kubecode.toggleContext')} aria-pressed={contextOpen} className="kubecode-layout-toggle" size="icon-xs" variant="ghost" onClick={() => {
            const nextOpen = togglePanel('context', contextOpen)
            setContextOpen(nextOpen)
            if (narrowLayout && nextOpen) setSessionSidebarOpen(false)
          }}>
            <PanelToggleIcon active={contextOpen} panel="right" />
          </Button>
        </div>
      </header>

      <div className="kubecode-workspace" data-narrow={narrowLayout} ref={workspaceRef}>
        {(sessionSidebarOpen || contextOpen) && (
          <button
            aria-label={t('kubecode.closeSidePanels')}
            className="kubecode-panel-backdrop"
            type="button"
            onClick={() => {
              setSessionSidebarOpen(false)
              setContextOpen(false)
            }}
          />
        )}
        {sessionSidebarOpen && (
          <>
            <nav
              aria-label={t('kubecode.projects')}
              className="kubecode-session-sidebar"
              style={{ width: sessionSidebarWidth }}
            >
              <div className="kubecode-navigator-heading">
                <strong>{t('kubecode.projects')}</strong>
                <div>
                  <Button aria-label={t('kubecode.addProject')} size="icon-xs" variant="ghost" onClick={() => setProjectDialog(true)}><Plus /></Button>
                  <Button aria-label={t('kubecode.settings')} size="icon-xs" variant="ghost" onClick={() => {
                    setSettingsSection('general')
                    setSettingsOpen(true)
                  }}><Gear /></Button>
                  <Button aria-label={t('kubecode.help')} size="icon-xs" variant="ghost"><Question /></Button>
                </div>
              </div>
              <SessionSidebarList
                activeConversationId={conversationId}
                activeProjectId={projectId}
                api={api}
                conversations={sessionCatalog}
                expandedProjectIds={expandedProjectIds}
                onConversationCreated={handleConversationCreated}
                onConversationRemoved={handleConversationRemoved}
                onConversationUpdated={handleConversationUpdated}
                onError={(cause) => setError(errorMessage(cause, t('kubecode.error')))}
                onNewSession={(nextProjectId) => {
                  if (nextProjectId !== projectId) selectProject(nextProjectId)
                  setSessionDialog(true)
                }}
                onProjectDelete={(nextProjectId) => void deleteProject(
                  projects.find((candidate) => candidate.id === nextProjectId),
                )}
                onProjectSelect={selectProject}
                onProjectToggle={toggleProjectExpanded}
                onProjectWorkspacesToggle={(nextProjectId) => {
                  const selectedProject = projects.find((candidate) => candidate.id === nextProjectId)
                  if (selectedProject) {
                    void setProjectWorkspacesEnabled(!selectedProject.workspaces_enabled, selectedProject)
                  }
                }}
                onSelect={openSession}
                projects={projects}
                projectStatuses={Object.fromEntries(projects.map((item) => [
                  item.id,
                  projectSessionStatus(projectRuns[item.id] ?? []),
                ]))}
                query={navigatorQuery}
                t={t}
                teams={teams}
              />
            </nav>
            <ResizeHandle onResize={resizeSessionSidebar} />
          </>
        )}

        <div className="kubecode-main-stack" ref={mainStackRef}>
          <div className="kubecode-session-context-row">
            <AgentSessionWorkspace
              agents={agents}
              agentsRefreshing={agentsRefreshing}
              allowTeammateChat={agentPreferences.allowTeammateChat}
              api={api}
              conversation={conversation}
              locale={locale}
              onConversationCreated={handleConversationCreated}
              projectId={projectId}
              onConversationRemoved={handleConversationRemoved}
              onConversationUpdated={handleConversationUpdated}
              onAddProject={() => setProjectDialog(true)}
              onNewSession={() => setSessionDialog(true)}
              onOpenAgentSettings={() => {
                setSettingsSection('agents')
                setSettingsOpen(true)
              }}
              onOpenPlan={() => {
                setContextOpen(true)
                setPlanRevealVersion((current) => current + 1)
                trackEvent('kubecode_context_section_opened', { section: 'plan' })
              }}
              onPlanChange={setActiveSessionPlan}
              onRefreshAgents={refreshAgents}
              onTeamCreated={(team) => setTeams((current) => [
                ...current.filter((item) => item.team.id !== team.team.id),
                team,
              ])}
              onTeamUpdated={(team) => setTeams((current) => [
                ...current.filter((item) => item.team.id !== team.team.id),
                team,
              ])}
              t={t}
              team={activeTeam}
              titlebarTarget={titlebarTarget}
              onSelectTeamMember={setConversationId}
              workspaceEvents={workspaceEvents}
              key={conversationId ?? projectId ?? 'no-project'}
            />
            {contextOpen && (
              <>
                <ResizeHandle onResize={resizeContext} />
                <ContextWorkbench
                  api={api}
                  autoSave={editorPreferences.autoSave}
                  planEntries={activeSessionPlan}
                  planRevealVersion={planRevealVersion}
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
                conversationId={conversation?.id ?? null}
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
        onOpenAgentSettings={() => {
          setSettingsSection('agents')
          setSettingsOpen(true)
        }}
        onRefreshAgents={refreshAgents}
        onSession={handleConversationCreated}
        onTeam={(team) => {
          setTeams((current) => [...current.filter((item) => item.team.id !== team.team.id), team])
          handleConversationCreated(team.leader_conversation)
        }}
        t={t}
      />
      <KubecodeSettingsDialog
        agentPreferences={agentPreferences}
        agents={agents}
        agentsRefreshing={agentsRefreshing}
        appearance={appearance}
        editorPreferences={editorPreferences}
        notifications={notifications}
        notificationPermission={browserPermission}
        notificationTestStatus={notificationTestStatus}
        key={settingsSection}
        open={settingsOpen}
        requestedSection={settingsSection}
        onAppearanceChange={setAppearance}
        onAgentPreferencesChange={setAgentPreferences}
        onEditorPreferencesChange={setEditorPreferences}
        onNotificationsChange={setNotifications}
        onOpenChange={setSettingsOpen}
        onRequestNotificationPermission={requestNotificationPermission}
        onRefreshAgents={refreshAgents}
        onTestNotification={sendTestNotification}
        t={t}
        />
      </main>
      </SystemMessageProvider>
    </IconContext.Provider>
  )
}

function upsertConversation(current: Conversation[], conversation: Conversation): Conversation[] {
  const existing = current.find((item) => item.id === conversation.id)
  const updated = existing ? { ...existing, ...conversation } : conversation
  return [...current.filter((item) => item.id !== conversation.id), updated]
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

function applyWorkspaceRunEvents(
  current: Record<string, AgentRun[]>,
  events: WorkspaceEvent[],
): Record<string, AgentRun[]> {
  return events.reduce(applyWorkspaceRunEvent, current)
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

function applyWorkspaceConversationEvents(
  current: Conversation[],
  events: WorkspaceEvent[],
): Conversation[] {
  return events.reduce(applyWorkspaceConversationEvent, current)
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
  onOpenAgentSettings,
  onRefreshAgents,
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
  onOpenAgentSettings: () => void
  onRefreshAgents: () => Promise<void>
  onSession: (conversation: Conversation) => void
  onTeam: (team: TeamSnapshot) => void
  t: Translator
}) {
  const availableAgent = agents.find((agent) => agent.available)
  const [agentId, setAgentId] = useState<AgentId>(availableAgent?.id ?? 'codex')
  const [title, setTitle] = useState('')
  const [mode, setMode] = useState<'new' | 'import'>('new')
  const [sessionKind, setSessionKind] = useState<'session' | 'team'>('session')
  const [executionMode, setExecutionMode] = useState<'shared' | 'worktree'>('shared')
  const [providerSessions, setProviderSessions] = useState<ProviderSessionInfo[]>([])
  const [providerSessionId, setProviderSessionId] = useState<string | null>(null)
  const [loadingProviderSessions, setLoadingProviderSessions] = useState(false)
  const [providerError, setProviderError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [createFailure, setCreateFailure] = useState<ApiError | null>(null)

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
    setCreateFailure(null)
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
      setCreateFailure(cause instanceof ApiError ? cause : null)
      setCreateError(agentStartupErrorMessage(cause, t))
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
          <div className="kubecode-choice-grid kubecode-session-choice-grid" role="group">
            <Button
              aria-label={t('kubecode.startNewSession')}
              aria-pressed={mode === 'new'}
              data-active={mode === 'new'}
              variant="outline"
              onClick={() => setMode('new')}
            >
              <Plus />
              <span>{t('kubecode.startNewSession')}</span>
            </Button>
            <Button
              aria-label={t('kubecode.importAgentSession')}
              aria-pressed={mode === 'import'}
              data-active={mode === 'import'}
              variant="outline"
              onClick={() => setMode('import')}
            >
              <DownloadSimple />
              <span>{t('kubecode.importAgentSession')}</span>
            </Button>
          </div>
          {mode === 'new' && (
            <div className="kubecode-new-session-field">
              <span>{t('kubecode.sessionType')}</span>
              <div className="kubecode-choice-grid kubecode-session-choice-grid" role="group" aria-label={t('kubecode.sessionType')}>
                <Button
                  aria-label={t('kubecode.session')}
                  aria-pressed={sessionKind === 'session'}
                  data-active={sessionKind === 'session'}
                  variant="outline"
                  onClick={() => setSessionKind('session')}
                >
                  <User />
                  <span>{t('kubecode.session')}</span>
                </Button>
                <Button
                  aria-label={t('kubecode.teamSession')}
                  aria-pressed={sessionKind === 'team'}
                  data-active={sessionKind === 'team'}
                  variant="outline"
                  onClick={() => setSessionKind('team')}
                >
                  <UsersThree />
                  <span>{t('kubecode.teamSession')}</span>
                </Button>
              </div>
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
                <span>{sessionKind === 'team' ? t('kubecode.teamName') : t('kubecode.sessionTitle')}</span>
                <Input
                  aria-label={sessionKind === 'team' ? t('kubecode.teamName') : t('kubecode.sessionTitle')}
                  placeholder={sessionKind === 'team' ? t('kubecode.teamName') : t('kubecode.optionalSessionTitle')}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              {project?.workspaces_enabled && (
                <div className="kubecode-new-session-field">
                  <span>{t('kubecode.executionWorkspace')}</span>
                  <div className="kubecode-choice-grid" role="group" aria-label={t('kubecode.executionWorkspace')}>
                    <Button aria-pressed={executionMode === 'worktree'} data-active={executionMode === 'worktree'} variant="outline" onClick={() => setExecutionMode('worktree')}>
                      <span>{t('kubecode.newWorkspace')}</span>
                      <small>{t('kubecode.newWorkspaceDescription')}</small>
                    </Button>
                    <Button aria-pressed={executionMode === 'shared'} data-active={executionMode === 'shared'} variant="outline" onClick={() => setExecutionMode('shared')}>
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
                  detailsLabel={t('kubecode.details')}
                  dismissLabel={t('window.close')}
                  level="error"
                  message={providerError}
                  onDismiss={() => setProviderError(null)}
                />
              )}
            </div>
          )}
          {createError && (
            <div className="kubecode-agent-startup-error">
              <SystemMessageNotice
                detailsLabel={t('kubecode.details')}
                dismissLabel={t('window.close')}
                level="error"
                message={createError}
                onDismiss={() => {
                  setCreateError(null)
                  setCreateFailure(null)
                }}
              />
              {createFailure && (
                <code className="kubecode-agent-startup-code">
                  {createFailure.code}
                  {createFailure.stage ? ` · ${createFailure.stage}` : ''}
                </code>
              )}
              <div>
                <Button
                  disabled={creating}
                  size="sm"
                  variant="outline"
                  onClick={() => void create()}
                >
                  {t('kubecode.retry')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onOpenAgentSettings}
                >
                  {t('kubecode.openAgentSettings')}
                </Button>
                {createFailure?.code === 'agent_unavailable' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void onRefreshAgents()}
                  >
                    {t('kubecode.checkAgain')}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
        <DialogFooter className="kubecode-new-session-footer">
          <DialogClose asChild><Button disabled={creating} variant="ghost">{t('kubecode.cancel')}</Button></DialogClose>
          <Button
            aria-busy={creating}
            disabled={creating
              || !projectId
              || !availableAgent
              || (mode === 'import' && !providerSessionId)}
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
      <DialogContent className="kubecode-path-picker-dialog kubecode-project-path-dialog" showCloseButton={false}>
        <DialogHeader className="kubecode-path-picker-heading">
          <DialogTitle>{mode === 'create' ? t('kubecode.createProject') : t('kubecode.importProject')}</DialogTitle>
          <DialogDescription>{t('kubecode.projectPath')}</DialogDescription>
        </DialogHeader>
        <div className="kubecode-mode-switch">
          <Button variant={mode === 'create' ? 'default' : 'outline'} onClick={() => setMode('create')}>{t('kubecode.createProject')}</Button>
          <Button variant={mode === 'import' ? 'default' : 'outline'} onClick={() => setMode('import')}>{t('kubecode.importProject')}</Button>
        </div>
        <PathPicker
          ariaLabel={t('kubecode.projectPath')}
          emptyMessage={t('kubecode.noDirectoriesFound')}
          footer={(
            <>
              <div className="kubecode-path-picker-footer">
                <Button
                  aria-pressed={showHidden}
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => setShowHidden((current) => !current)}
                >
                  {showHidden ? <Eye /> : <EyeSlash />}
                  {t('kubecode.showHiddenDirectories')}
                </Button>
              </div>
              {browserError && (
                <div className="kubecode-path-picker-error" role="alert">{browserError}</div>
              )}
            </>
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

function KubecodeSettingsDialog({
  agentPreferences,
  agents,
  agentsRefreshing,
  appearance,
  editorPreferences,
  notifications,
  notificationPermission: browserPermission,
  notificationTestStatus,
  open,
  requestedSection,
  onAppearanceChange,
  onAgentPreferencesChange,
  onEditorPreferencesChange,
  onNotificationsChange,
  onOpenChange,
  onRequestNotificationPermission,
  onRefreshAgents,
  onTestNotification,
  t,
}: {
  agentPreferences: KubecodeAgentPreferences
  agents: AgentDescriptor[]
  agentsRefreshing: boolean
  appearance: KubecodeAppearance
  editorPreferences: KubecodeEditorPreferences
  notifications: KubecodeNotifications
  notificationPermission: BrowserNotificationPermission
  notificationTestStatus: BrowserNotificationDelivery['status'] | null
  open: boolean
  requestedSection: SettingsSection
  onAppearanceChange: (appearance: KubecodeAppearance) => void
  onAgentPreferencesChange: (preferences: KubecodeAgentPreferences) => void
  onEditorPreferencesChange: (preferences: KubecodeEditorPreferences) => void
  onNotificationsChange: (notifications: KubecodeNotifications) => void
  onOpenChange: (open: boolean) => void
  onRequestNotificationPermission: () => Promise<void>
  onRefreshAgents: () => Promise<void>
  onTestNotification: () => Promise<void>
  t: Translator
}) {
  const [section, setSection] = useState<SettingsSection>(requestedSection)
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false)

  const copyDiagnostics = async () => {
    const report = {
      schema_version: 1,
      agents: agents.map((agent) => ({
        id: agent.id,
        readiness: agent.readiness ?? (agent.available ? 'ready' : 'unavailable'),
        cli_version: agent.cli?.version ?? agent.version,
        cli_source: agent.cli?.source ?? null,
        cli_error_code: agent.cli?.error_code ?? null,
        adapter_kind: agent.adapter?.kind ?? (agent.id === 'opencode' ? 'native' : 'bundled'),
        adapter_version: agent.adapter?.version ?? null,
        adapter_error_code: agent.adapter?.error_code ?? null,
        checked_at: agent.checked_at ?? null,
      })),
    }
    await navigator.clipboard?.writeText(JSON.stringify(report, null, 2))
    setDiagnosticsCopied(true)
    window.setTimeout(() => setDiagnosticsCopied(false), 1800)
  }

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
                      <SelectItem key={theme} value={theme}>
                        <span
                          aria-hidden="true"
                          className="kubecode-theme-swatch"
                          style={{ '--theme-preview': THEME_PREVIEWS[theme] } as CSSProperties}
                        />
                        {t(`kubecode.theme.${theme}`)}
                      </SelectItem>
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
                <div>
                  <strong>{t('kubecode.uiFontSize')}</strong>
                  <span>{t('kubecode.uiFontSizeDescription')}</span>
                </div>
                <Select
                  value={String(appearance.uiFontSize)}
                  onValueChange={(value) => {
                    updateAppearance('uiFontSize', Number(value))
                    trackEvent('kubecode_appearance_changed', {
                      setting: 'uiFontSize',
                      value: Number(value),
                    })
                  }}
                >
                  <SelectTrigger aria-label={t('kubecode.uiFontSize')} className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 9 }, (_, index) => index + 12).map((size) => (
                      <SelectItem key={size} value={String(size)}>{size}px</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
          {section === 'agents' && (
            <div className="kubecode-settings-group">
              <div className="kubecode-setting-row">
                <div>
                  <strong>{t('kubecode.allowTeammateChat')}</strong>
                  <span>{t('kubecode.allowTeammateChatDescription')}</span>
                </div>
                <Switch
                  aria-label={t('kubecode.allowTeammateChat')}
                  checked={agentPreferences.allowTeammateChat}
                  onCheckedChange={(allowTeammateChat) => {
                    onAgentPreferencesChange({ ...agentPreferences, allowTeammateChat })
                    trackEvent('kubecode_agent_preference_changed', {
                      setting: 'allowTeammateChat',
                      value: allowTeammateChat ? 'on' : 'off',
                    })
                  }}
                />
              </div>
              <div className="kubecode-setting-row kubecode-agent-doctor-toolbar">
                <div>
                  <strong>{t('kubecode.agentReadiness')}</strong>
                  <span>{t('kubecode.agentReadinessDescription')}</span>
                </div>
                <div className="kubecode-agent-doctor-actions">
                  <Button
                    disabled={agentsRefreshing}
                    size="sm"
                    variant="outline"
                    onClick={() => void onRefreshAgents()}
                  >
                    <ArrowClockwise className={agentsRefreshing ? 'animate-spin' : undefined} />
                    {t('kubecode.checkAgain')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void copyDiagnostics()}>
                    {diagnosticsCopied ? <Check /> : <Copy />}
                    {diagnosticsCopied ? t('kubecode.copied') : t('kubecode.copyDiagnostics')}
                  </Button>
                </div>
              </div>
              {agents.map((agent) => (
                <details className="kubecode-agent-diagnostic" key={agent.id}>
                  <summary>
                    <span>
                      <AiAgentIcon agent={agent.id} size={18} />
                      <strong>{agentName(agent.id)}</strong>
                    </span>
                    <span data-available={agent.available}>
                      {agent.available ? agent.version ?? t('kubecode.ready') : t('kubecode.unavailable')}
                    </span>
                  </summary>
                  <div className="kubecode-agent-diagnostic-body">
                    <AgentDiagnosticRow
                      detail={agent.cli?.detail ?? agent.error}
                      label={t('kubecode.agentCli')}
                      status={agent.cli?.status ?? (agent.available ? 'ready' : 'missing')}
                      value={agent.cli?.version ?? agent.version ?? agent.executable}
                      t={t}
                    />
                    <AgentDiagnosticRow
                      detail={agent.adapter?.detail}
                      label={agent.adapter?.kind === 'native'
                        ? t('kubecode.nativeAcp')
                        : t('kubecode.acpAdapter')}
                      status={agent.adapter?.status ?? (agent.available ? 'ready' : 'missing')}
                      value={agent.adapter?.kind === 'native'
                        ? t('kubecode.builtIntoAgent')
                        : agent.adapter?.version ?? undefined}
                      t={t}
                    />
                    <div className="kubecode-agent-auth-note">
                      {t('kubecode.authenticationCheckedOnSession')}
                    </div>
                    {agent.checked_at && (
                      <small>{t('kubecode.lastChecked', {
                        time: new Date(agent.checked_at).toLocaleTimeString(),
                      })}</small>
                    )}
                  </div>
                </details>
              ))}
            </div>
          )}
          {section === 'editor' && (
            <div className="kubecode-settings-group">
              <div className="kubecode-setting-row">
                <div>
                  <strong>{t('kubecode.autoSave')}</strong>
                  <span>{t('kubecode.autoSaveDescription')}</span>
                </div>
                <Switch
                  aria-label={t('kubecode.autoSave')}
                  checked={editorPreferences.autoSave}
                  onCheckedChange={(autoSave) => {
                    onEditorPreferencesChange({ ...editorPreferences, autoSave })
                    trackEvent('kubecode_editor_preference_changed', {
                      setting: 'autoSave',
                      value: autoSave ? 'on' : 'off',
                    })
                  }}
                />
              </div>
            </div>
          )}
          {section === 'terminal' && (
            <div className="kubecode-settings-placeholder">{t('kubecode.settingsComingSoon')}</div>
          )}
        </section>
      </DialogContent>
    </Dialog>
  )
}

function AgentDiagnosticRow({
  detail,
  label,
  status,
  t,
  value,
}: {
  detail?: string | null
  label: string
  status: 'ready' | 'missing' | 'error'
  t: Translator
  value?: string | null
}) {
  return (
    <div className="kubecode-agent-diagnostic-row">
      <span data-status={status}>{status === 'ready' ? <Check /> : <WarningCircle />}</span>
      <div>
        <strong>{label}</strong>
        <small>{value || (status === 'ready' ? t('kubecode.ready') : t('kubecode.unavailable'))}</small>
        {detail && <code>{detail}</code>}
      </div>
    </div>
  )
}

function agentStartupErrorMessage(cause: unknown, t: Translator): string {
  if (!(cause instanceof ApiError)) return errorMessage(cause, t('kubecode.error'))
  switch (cause.code) {
    case 'agent_adapter_unavailable':
      return t('kubecode.agentError.adapter')
    case 'agent_process_spawn_failed':
      return t('kubecode.agentError.process')
    case 'agent_initialize_failed':
      return t('kubecode.agentError.initialize')
    case 'agent_session_new_failed':
      return t('kubecode.agentError.sessionNew')
    case 'agent_session_load_failed':
    case 'agent_session_resume_failed':
      return t('kubecode.agentError.sessionRestore')
    case 'agent_authentication_failed':
      return t('kubecode.agentError.authentication')
    case 'agent_project_directory_failed':
      return t('kubecode.agentError.directory')
    case 'agent_unavailable':
      return t('kubecode.agentError.unavailable')
    default:
      return errorMessage(cause, t('kubecode.error'))
  }
}

function agentName(id: AgentId): string {
  if (id === 'claude_code') return 'Claude Code'
  if (id === 'opencode') return 'OpenCode'
  return 'Codex'
}

const THEME_PREVIEWS: Record<KubecodeTheme, string> = {
  opencode: 'linear-gradient(135deg, #111218 0 48%, #7c72e8 48% 72%, #f3f2fa 72%)',
  system: 'linear-gradient(135deg, #ffffff 0 48%, #8b8b8b 48% 52%, #1f1e1b 52%)',
  tokyonight: 'linear-gradient(135deg, #1a1b26 0 58%, #7aa2f7 58%)',
  everforest: 'linear-gradient(135deg, #2d353b 0 58%, #83c092 58%)',
  ayu: 'linear-gradient(135deg, #0b0e14 0 58%, #ffb454 58%)',
  catppuccin: 'linear-gradient(135deg, #1e1e2e 0 58%, #cba6f7 58%)',
  'catppuccin-macchiato': 'linear-gradient(135deg, #24273a 0 58%, #8aadf4 58%)',
  gruvbox: 'linear-gradient(135deg, #282828 0 58%, #d79921 58%)',
  kanagawa: 'linear-gradient(135deg, #1f1f28 0 58%, #7e9cd8 58%)',
  nord: 'linear-gradient(135deg, #2e3440 0 58%, #88c0d0 58%)',
  matrix: 'linear-gradient(135deg, #050b07 0 58%, #00c853 58%)',
  'one-dark': 'linear-gradient(135deg, #282c34 0 58%, #61afef 58%)',
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

function useNarrowWorkbench(): boolean {
  const query = '(max-width: 980px)'
  const readMatch = () => (
    typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : window.innerWidth <= 980
  )
  const [narrow, setNarrow] = useState(readMatch)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      const handleResize = () => setNarrow(readMatch())
      window.addEventListener('resize', handleResize)
      return () => window.removeEventListener('resize', handleResize)
    }
    const media = window.matchMedia(query)
    const handleChange = (event: MediaQueryListEvent) => setNarrow(event.matches)
    media.addEventListener('change', handleChange)
    return () => media.removeEventListener('change', handleChange)
  }, [])

  return narrow
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
