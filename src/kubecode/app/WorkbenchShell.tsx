import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RiNotification3Fill } from '@remixicon/react'
import { createTranslator, resolveEffectiveLocale, type Translator } from '@/lib/i18n'
import { trackEvent } from '@/lib/telemetry'

import { Button } from '@/components/ui/button'
import { ResizeHandle } from '@/components/ResizeHandle'

import { AgentSessionWorkspace, type SessionPlanEntry } from '../AgentSessionWorkspace'
import { GlobalCommandPalette } from '../GlobalCommandPalette'
import { createHostActionRegistry, type RegisteredHostAction } from '../hostActions'
import {
  isGlobalCommandPaletteShortcut,
  type CommandPaletteSessionSnapshot,
  type RankedCommandPaletteItem,
} from '../commandPalette'
import { ContextWorkbench } from '../ContextWorkbench'
import { ChannelNavigator } from '../channel/ChannelNavigator'
import { TaskBoardView } from '../tasks/TaskBoardView'
import { TaskInspector } from '../tasks/TaskInspector'
import { MemberProfile } from '../members/MemberProfile'
import { MembersView } from '../members/MembersView'
import { useMembers } from '../members/useMembers'
import { ResourcesView } from '../resources/ResourcesView'
import { useTaskBoard } from '../tasks/useTaskBoard'
import { ChannelWorkspace } from '../channel/ChannelWorkspace'
import { DmPane } from '../dm/DmPane'
import { useChannelThreads, useDefaultChannel } from '../channel/useChannel'
import { NewResearchDialog } from '../research/NewResearchDialog'
import { ResearchNavigator } from '../research/ResearchNavigator'
import { ResearchWorkspace } from '../research/ResearchWorkspace'
import { useResearchList } from '../research/useResearch'
import { Icon } from '../icons'
import { DisableWorkspacesDialog } from '../DisableWorkspacesDialog'
import { terminalFontStack } from '../appearancePreferences'
import { KubecodeApi, type AgentRun, type Conversation, type Member, type MemberDefaults, type Project, type TeamSnapshot, type TerminalInfo } from '../api'
import { TerminalWorkspace, type TerminalContextSource } from '../TerminalWorkspace'
import { SystemMessageProvider } from '../SystemMessageNotice'
import { WorkspaceNotificationBridge } from '../WorkspaceNotificationBridge'
import {
  readProjectWorkbenchLayout,
  writeProjectWorkbenchLayout,
  writeWorkbenchNavigatorLayout,
} from '../workbenchLayout'
import type { NotificationCategory } from '../notificationPreferences'

import '../kubecode.css'

import { errorMessage } from './errors'
import { NewSessionDialog } from './NewSessionDialog'
import { ProjectDialog } from './ProjectDialog'
import { ProjectNavigator } from './ProjectNavigator'
import { SettingsDialog, type SettingsSection } from './SettingsDialog'
import { DetailPane } from './DetailPane'
import { WorkspaceNav } from './WorkspaceNav'
import { useWorkspaceRouteSync } from './useWorkspaceRouteSync'
import type { WorkspaceRoute } from './workspaceRoute'
import { useProjectSelection } from './useProjectSelection'
import { useWorkbenchPreferences } from './useWorkbenchPreferences'
import { useWorkspaceBootstrap } from './useWorkspaceBootstrap'
import { useWeChatBinding } from './useWeChatBinding'
import { useWorkspaceReconciliation } from './useWorkspaceReconciliation'
import { togglePanel } from './panelToggles'
import { WorkbenchTitlebar } from './WorkbenchTitlebar'
import { mergeConversations, upsertConversation } from './sessionCatalog'

const browserApi = new KubecodeApi()

/** What the main pane shows besides the Sessions surface (ADR 0224). */
type ViewState =
  | { kind: 'research'; projectId: string; researchId: string }
  | {
    kind: 'channel'
    projectId: string
    threadId: string | null
    /** A message to land on, and to come back to from the Task detail. */
    message?: string | null
    /** The Task open in the detail pane. */
    task?: string | null
    /** Show only the messages about this Task. */
    filter?: string | null
  }
  | { kind: 'work'; projectId: string; task?: string | null }
  | { kind: 'dm'; projectId: string; member: Member }
  | { kind: 'resources'; projectId: string }
  | { kind: 'members'; projectId: string; memberId?: string | null }

const focusSessionSearchTarget: { current: (() => void) | null } = { current: null }

export function WorkbenchShell({ api = browserApi }: { api?: KubecodeApi }) {
  const locale = useMemo(() => resolveEffectiveLocale(null), [])
  const t = useMemo(() => createTranslator(locale), [locale])
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [terminals, setTerminals] = useState<TerminalInfo[]>([])
  const [terminalContextSources, setTerminalContextSources] = useState<TerminalContextSource[]>([])
  const [terminalsLoadedForProjectId, setTerminalsLoadedForProjectId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [teams, setTeams] = useState<TeamSnapshot[]>([])
  const [allConversations, setAllConversations] = useState<Conversation[]>([])
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [workspaceCursor, setWorkspaceCursor] = useState<number | null>(null)
  const [expandedProjectIds, setExpandedProjectIds] = useState<string[]>([])
  const [projectDialog, setProjectDialog] = useState(false)
  const [sessionDialog, setSessionDialog] = useState(false)
  const [researchDialog, setResearchDialog] = useState(false)
  // What the main pane shows besides the Sessions surface. One value, so two
  // views can never both claim the pane.
  const [viewState, setViewState] = useState<ViewState | null>(null)
  const [memberDefaults, setMemberDefaults] = useState<MemberDefaults | null>(null)
  // Files and Git are tools of the work in hand, not a permanent column of the
  // research views: they open on request there.
  const [researchToolsOpen, setResearchToolsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [commandPaletteSession, setCommandPaletteSession] = useState<CommandPaletteSessionSnapshot | null>(null)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general')
  const [disableWorkspacesOpen, setDisableWorkspacesOpen] = useState(false)
  const [sessionSidebarOpen, setSessionSidebarOpen] = useState(true)
  const [contextOpen, setContextOpen] = useState(true)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [navigatorQuery, setNavigatorQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sessionSidebarWidth, setSessionSidebarWidth] = useState(280)
  const [contextWidth, setContextWidth] = useState(440)
  const [terminalHeight, setTerminalHeight] = useState(260)
  const [titlebarTarget, setTitlebarTarget] = useState<HTMLDivElement | null>(null)
  const [activeSessionPlan, setActiveSessionPlan] = useState<SessionPlanEntry[]>([])
  const [planRevealVersion, setPlanRevealVersion] = useState(0)
  const narrowLayout = useNarrowWorkbench()
  // A view belongs to a Project; choosing another Project hides it.
  const inProject = viewState && viewState.projectId === projectId ? viewState : null
  // Files and Git are a column beside Sessions; beside the research views they
  // open when asked for and are gone again when the view is left.
  const contextVisible = inProject ? researchToolsOpen : contextOpen
  const setContextVisible = useCallback((open: boolean | ((current: boolean) => boolean)) => {
    if (inProject) setResearchToolsOpen(open)
    else setContextOpen(open)
  }, [inProject])

  const workspaceRef = useRef<HTMLDivElement>(null)
  const mainStackRef = useRef<HTMLDivElement>(null)
  const navigatorSearchRef = useRef<HTMLInputElement>(null)
  const commandPaletteReturnFocusRef = useRef<HTMLElement | null>(null)
  const commandPaletteSkipRestoreRef = useRef(false)

  const preferences = useWorkbenchPreferences(t)
  const {
    agentPreferences,
    appearance,
    browserPermission,
    dismissNotificationOnboarding,
    editorPreferences,
    notificationOnboardingSuppressed,
    notifications,
    requestNotificationPermission,
  } = preferences

  const projectIdRef = useRef(projectId)
  useEffect(() => { projectIdRef.current = projectId }, [projectId])
  const project = projects.find((item) => item.id === projectId) ?? null
  const conversation = conversations.find((item) => item.id === conversationId) ?? null
  const activeTeam = teams.find((team) => (
    team.members.some((member) => member.conversation_id === conversationId)
  )) ?? null
  const sessionCatalog = useMemo(
    () => mergeConversations(allConversations, conversations),
    [allConversations, conversations],
  )

  const applyProjectLayout = useCallback((nextProjectId: string) => {
    const layout = readProjectWorkbenchLayout(localStorage, nextProjectId)
    setContextWidth(layout.contextWidth)
    setTerminalHeight(layout.terminalHeight)
    setContextOpen(layout.contextOpen)
    setTerminalOpen(layout.terminalOpen)
  }, [])

  const reconciliation = useWorkspaceReconciliation(api, t, {
    projectId,
    cursor: workspaceCursor,
    setAllConversations,
    setConversations,
    setConversationId,
    setTeams,
    setTerminals,
    setTerminalsLoadedForProjectId,
    setError,
  })
  const wechatBinding = useWeChatBinding(api, reconciliation.workspaceEvents)
  const research = useResearchList(
    api,
    projectId,
    reconciliation.workspaceEvents,
    reconciliation.connectionState,
  )
  const researchSelection = inProject?.kind === 'research' ? inProject : null
  const channelSelection = inProject?.kind === 'channel' ? inProject : null
  const workSelection = inProject?.kind === 'work' ? inProject : null
  const dmSelection = inProject?.kind === 'dm' ? inProject : null
  const resourcesSelection = inProject?.kind === 'resources' ? inProject : null
  const membersSelection = inProject?.kind === 'members' ? inProject : null
  const researchId = researchSelection?.researchId ?? null
  const workView = workSelection
  const channelView = channelSelection
  const dmView = dmSelection
  /** Each setter replaces whatever view was shown; `null` closes only its own. */
  const setResearchSelection = useCallback((value: { projectId: string; researchId: string } | null) => {
    setViewState((current) => value ? { kind: 'research', ...value } : current?.kind === 'research' ? null : current)
  }, [])
  const setChannelSelection = useCallback((value: Omit<Extract<ViewState, { kind: 'channel' }>, 'kind'> | null) => {
    setViewState((current) => value ? { kind: 'channel', ...value } : current?.kind === 'channel' ? null : current)
  }, [])
  const setWorkSelection = useCallback((value: Omit<Extract<ViewState, { kind: 'work' }>, 'kind'> | null) => {
    setViewState((current) => value ? { kind: 'work', ...value } : current?.kind === 'work' ? null : current)
  }, [])
  const setDmSelection = useCallback((value: { projectId: string; member: Member } | null) => {
    setViewState((current) => value ? { kind: 'dm', ...value } : current?.kind === 'dm' ? null : current)
  }, [])
  /** Changes parts of the open General view from the latest state, never a stale copy. */
  const patchChannel = useCallback((patch: Partial<Omit<Extract<ViewState, { kind: 'channel' }>, 'kind' | 'projectId'>>) => {
    setViewState((current) => (current?.kind === 'channel' ? { ...current, ...patch } : current))
  }, [])
  const defaultChannel = useDefaultChannel(api, projectId)
  const channelThreads = useChannelThreads(
    api,
    projectId,
    defaultChannel.channel?.id ?? null,
    reconciliation.workspaceEvents,
    reconciliation.connectionState,
  )
  const roster = useMembers(api, projectId, reconciliation.workspaceEvents, reconciliation.connectionState)
  /** The member whose profile is open; none while the roster loads or for an unknown id. */
  const profileMember = membersSelection?.memberId
    ? roster.roster?.members.find((member) => member.id === membersSelection.memberId) ?? null
    : null
  const taskBoard = useTaskBoard(api, projectId, reconciliation.workspaceEvents, reconciliation.connectionState)
  /** Back to the Session surface: no research view is shown. */
  const showSessions = useCallback(() => setViewState(null), [])
  const tasksOnBoard = useMemo(
    () => new Set((taskBoard.board?.cards ?? []).map((card) => card.id)),
    [taskBoard.board],
  )
  /** What waits for the researcher: results to review and requested input. */
  const needsYouTasks = useMemo(
    () => (taskBoard.board?.cards ?? []).filter((card) => (
      card.stage === 'review' || card.condition === 'needs_input'
    )),
    [taskBoard.board],
  )
  /** Opens the private conversation with a member. */
  const openDm = useCallback(async (member: Member) => {
    if (!projectId) return
    try {
      const opened = await api.openMemberDm(projectId, member.id)
      // The researcher may have gone elsewhere while it opened.
      if (projectIdRef.current !== projectId) return
      setViewState({ kind: 'dm', projectId, member: opened })
      setSettingsOpen(false)
      if (narrowLayout) setSessionSidebarOpen(false)
    } catch (cause) {
      setError(errorMessage(cause, t('kubecode.error')))
    }
  }, [api, narrowLayout, projectId, t])

  const selection = useProjectSelection(api, t, {
    projectId,
    projects,
    setProjects,
    setProjectId,
    setConversationId,
    setExpandedProjectIds,
    setConversations,
    setTeams,
    setTerminals,
    setTerminalsLoadedForProjectId,
    setActiveSessionPlan,
    setAllConversations,
    setProjectRuns: reconciliation.setProjectRuns,
    setDisableWorkspacesOpen,
    setError,
    applyProjectLayout,
  })

  const bootstrap = useWorkspaceBootstrap(api, t, {
    projectId,
    applyProjectLayout,
    setProjects,
    setProjectId,
    setSessionSidebarOpen,
    setSessionSidebarWidth,
    setExpandedProjectIds,
    setProjectRuns: reconciliation.setProjectRuns,
    setWorkspaceCursor,
    setAllConversations,
    setTerminals,
    setTerminalsLoadedForProjectId,
    setConversations,
    setConversationId,
    setTeams,
    setError,
  })
  const { agents, agentsRefreshing, layoutHydrated, refreshAgents } = bootstrap
  const attentionSessions = useMemo(
    () => sessionsRequiringInput(reconciliation.projectRuns, sessionCatalog),
    [reconciliation.projectRuns, sessionCatalog],
  )

  // -- Where the researcher is, as a route (ADR 0224) -------------------------------------
  const currentRoute = useMemo<WorkspaceRoute>(() => {
    const view = inProject
    const project = projectId
    if (!view) return { project, view: 'sessions', conversation: conversationId ?? undefined }
    switch (view.kind) {
      case 'channel':
        return {
          project,
          view: 'general',
          message: view.message ?? undefined,
          task: view.task ?? undefined,
          filter: view.filter ?? undefined,
          thread: view.threadId ?? undefined,
        }
      case 'work': return { project, view: 'board', task: view.task ?? undefined }
      case 'dm': return { project, view: 'dm', member: view.member.id }
      case 'resources': return { project, view: 'resources' }
      case 'members': return { project, view: 'members', member: view.memberId ?? undefined }
      default: return { project, view: 'question', question: view.researchId }
    }
  }, [conversationId, inProject, projectId])

  const applyRoute = useCallback((route: WorkspaceRoute) => {
    const target = route.project ?? projectIdRef.current
    if (!target) return
    if (target !== projectIdRef.current) {
      if (!projects.some((item) => item.id === target)) return
      selection.selectProject(target)
    }
    switch (route.view) {
      case 'sessions':
        setViewState(null)
        if (route.conversation) selection.openSession(target, route.conversation)
        break
      case 'general':
        setViewState({
          kind: 'channel',
          projectId: target,
          threadId: route.thread ?? null,
          message: route.message ?? null,
          task: route.task ?? null,
          filter: route.filter ?? null,
        })
        break
      case 'board':
        setViewState({ kind: 'work', projectId: target, task: route.task ?? null })
        break
      case 'resources':
        setViewState({ kind: 'resources', projectId: target })
        break
      case 'members':
        setViewState({ kind: 'members', projectId: target, memberId: route.member ?? null })
        break
      case 'question':
        if (route.question) setViewState({ kind: 'research', projectId: target, researchId: route.question })
        break
      case 'dm':
        if (route.member) {
          void api.openMemberDm(target, route.member).then((opened) => {
            if (projectIdRef.current !== target) return
            setViewState({ kind: 'dm', projectId: target, member: opened })
          }).catch((cause) => setError(errorMessage(cause, t('kubecode.error'))))
        }
        break
    }
  }, [api, projects, selection, t])
  useWorkspaceRouteSync({
    apply: applyRoute,
    current: currentRoute,
    ready: layoutHydrated && projectId !== null,
  })

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

  useEffect(() => {
    // Surface workspace-stream failures through the existing application error state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (reconciliation.workspaceEventDiagnostic) setError(t('kubecode.error'))
  }, [t, reconciliation.workspaceEventDiagnostic])

  const notificationOnboardingOpen = !notificationOnboardingSuppressed
    && !notifications.onboardingDismissed
    && browserPermission === 'default'
    && reconciliation.workspaceEvents.some((event) => event.kind === 'run_started')

  useEffect(() => {
    const focusNavigatorSearch = (event: KeyboardEvent) => {
      if (event.defaultPrevented
        || event.altKey
        || event.shiftKey
        || event.key.toLocaleLowerCase() !== 'k'
        || (!event.metaKey && !event.ctrlKey)) return
      event.preventDefault()
      navigatorSearchRef.current?.focus()
      navigatorSearchRef.current?.select()
    }
    document.addEventListener('keydown', focusNavigatorSearch)
    return () => document.removeEventListener('keydown', focusNavigatorSearch)
  }, [])

  useEffect(() => {
    const openCommandPalette = (event: KeyboardEvent) => {
      if (event.defaultPrevented
        || document.querySelector('[role="dialog"]')
        || !isGlobalCommandPaletteShortcut(event)) return
      event.preventDefault()
      event.stopPropagation()
      commandPaletteReturnFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
      commandPaletteSkipRestoreRef.current = false
      setCommandPaletteOpen(true)
    }
    document.addEventListener('keydown', openCommandPalette, true)
    return () => document.removeEventListener('keydown', openCommandPalette, true)
  }, [])

  useEffect(() => {
    focusSessionSearchTarget.current = () => {
      window.requestAnimationFrame(() => {
        navigatorSearchRef.current?.focus()
        navigatorSearchRef.current?.select()
      })
    }
  }, [])

  useEffect(() => {
    if (!narrowLayout || (!sessionSidebarOpen && !contextVisible)) return
    const closeOverlayPanels = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('[role="dialog"]')) return
      setSessionSidebarOpen(false)
      setContextVisible(false)
    }
    document.addEventListener('keydown', closeOverlayPanels)
    return () => document.removeEventListener('keydown', closeOverlayPanels)
  }, [contextVisible, narrowLayout, sessionSidebarOpen, setContextVisible])

  useEffect(() => {
    // On narrow layouts, the navigator takes precedence if both overlays are open.
    if (!narrowLayout || !sessionSidebarOpen || !contextVisible) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setContextVisible(false)
  }, [contextVisible, narrowLayout, sessionSidebarOpen, setContextVisible])

  // The tools asked for beside the research views are gone again when the
  // researcher leaves them for the Sessions surface.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (viewState === null) setResearchToolsOpen(false)
  }, [viewState])

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

  const handleConversationCreated = useCallback((created: Conversation) => {
    showSessions()
    setConversations((current) => upsertConversation(current, created))
    setAllConversations((current) => upsertConversation(current, created))
    setConversationId(created.id)
  }, [showSessions])

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

  /** A Task's research record as the detail pane: brief, work, findings, evidence. */
  const taskPane = (taskId: string, close: () => void) => projectId ? (
    <DetailPane key={taskId} label={t('kubecode.nav.taskDetail')} onClose={close}>
      <ResearchWorkspace
        agents={agents}
        api={api}
        backLabel={t('kubecode.nav.closeDetail')}
        connectionState={reconciliation.connectionState}
        conversations={sessionCatalog}
        events={reconciliation.workspaceEvents}
        projectId={projectId}
        researchId={taskId}
        t={t}
        teams={teams}
        inspector={(
          <TaskInspector
            api={api}
            connectionState={reconciliation.connectionState}
            events={reconciliation.workspaceEvents}
            projectId={projectId}
            t={t}
            taskId={taskId}
            onShowMessage={(messageId) => setChannelSelection({ projectId, threadId: null, message: messageId })}
          />
        )}
        onClose={close}
        onConversationCreated={handleConversationCreated}
        onOpenBoard={(filter) => setWorkSelection({ projectId, task: filter.research_id ?? null })}
        onOpenSession={(nextConversationId) => {
          showSessions()
          selection.openSession(projectId, nextConversationId)
        }}
        onOpenThread={(threadId) => setChannelSelection({ projectId, threadId })}
      />
    </DetailPane>
  ) : null

  const commandPaletteHostActions = createHostActionRegistry({
    addProject: () => setProjectDialog(true),
    focusSessionSearch: () => focusSessionSearchTarget.current?.(),
    newSession: () => setSessionDialog(true),
    openSettings: () => {
      setSettingsSection('general')
      setSettingsOpen(true)
    },
    toggleContext: () => {
      setContextVisible((open) => {
        const nextOpen = togglePanel('context', open)
        if (narrowLayout && nextOpen) setSessionSidebarOpen(false)
        return nextOpen
      })
    },
    toggleNavigator: () => {
      setSessionSidebarOpen((open) => {
        const nextOpen = togglePanel('sessions', open)
        if (narrowLayout && nextOpen) setContextVisible(false)
        return nextOpen
      })
    },
    toggleTerminal: () => setTerminalOpen((open) => togglePanel('terminal', open)),
  }, { hasProject: Boolean(projectId) })

  const runCommandPaletteHostAction = (action: RegisteredHostAction) => {
    if (!action.enabled) return
    commandPaletteSkipRestoreRef.current = [
      'add-project',
      'focus-session-search',
      'new-session',
      'open-settings',
    ].includes(action.id)
    setCommandPaletteOpen(false)
    action.execute()
  }

  const runCommandPaletteCatalogItem = (item: RankedCommandPaletteItem) => {
    const session = commandPaletteSession
    if (!session?.writable
      || session.conversationId !== conversationId
      || session.projectId !== projectId) return
    commandPaletteSkipRestoreRef.current = true
    setCommandPaletteOpen(false)
    void session.execute(item)
  }

  return (
    <SystemMessageProvider detailsLabel={t('kubecode.details')} dismissLabel={t('window.close')}>
    <main className="kubecode-app">
      <WorkbenchTitlebar
        attentionSessions={attentionSessions}
        connectionState={reconciliation.connectionState}
        contextOpen={contextVisible}
        conversation={conversation}
        error={error}
        lastSuccessfulSyncAt={reconciliation.lastSuccessfulSyncAt}
        locale={locale}
        narrowLayout={narrowLayout}
        navigatorQuery={navigatorQuery}
        navigatorSearchRef={navigatorSearchRef}
        onContextOpenChange={setContextVisible}
        onNavigatorQueryChange={setNavigatorQuery}
        onOpenSession={(nextProjectId, nextConversationId) => {
          showSessions()
          selection.openSession(nextProjectId, nextConversationId)
        }}
        onRetryConnection={reconciliation.retry}
        onSessionSidebarOpenChange={setSessionSidebarOpen}
        onTerminalOpenChange={setTerminalOpen}
        project={project}
        projects={projects}
        sessionSidebarOpen={sessionSidebarOpen}
        t={t}
        terminalOpen={terminalOpen}
        titlebarTargetRef={setTitlebarTarget}
      />

      <div className="kubecode-workspace" data-narrow={narrowLayout} ref={workspaceRef}>
        {(sessionSidebarOpen || contextVisible) && (
          <button
            aria-label={t('kubecode.closeSidePanels')}
            className="kubecode-panel-backdrop"
            type="button"
            onClick={() => {
              setSessionSidebarOpen(false)
              setContextVisible(false)
            }}
          />
        )}
        {sessionSidebarOpen && (
          <ProjectNavigator
            activeConversationId={conversationId}
            activeProjectId={projectId}
            api={api}
            conversations={sessionCatalog}
            expandedProjectIds={expandedProjectIds}
            navigatorWidth={sessionSidebarWidth}
            onAddProject={() => setProjectDialog(true)}
            onConversationCreated={handleConversationCreated}
            onConversationRemoved={handleConversationRemoved}
            onConversationUpdated={handleConversationUpdated}
            onError={(cause) => setError(errorMessage(cause, t('kubecode.error')))}
            onNewSession={(nextProjectId) => {
              if (nextProjectId !== projectId) selection.selectProject(nextProjectId)
              setSessionDialog(true)
            }}
            onOpenSettings={() => {
              setSettingsSection('general')
              setSettingsOpen(true)
            }}
            onProjectDelete={(nextProjectId) => void selection.deleteProject(
              projects.find((candidate) => candidate.id === nextProjectId),
            )}
            onProjectSelect={(nextProjectId) => {
              showSessions()
              selection.selectProject(nextProjectId)
            }}
            onProjectToggle={selection.toggleProjectExpanded}
            onProjectWorkspacesToggle={(nextProjectId) => {
              const selectedProject = projects.find((candidate) => candidate.id === nextProjectId)
              if (selectedProject) {
                void selection.setProjectWorkspacesEnabled(!selectedProject.workspaces_enabled, selectedProject)
              }
            }}
            onResize={resizeSessionSidebar}
            onSelect={(nextProjectId, nextConversationId) => {
              showSessions()
              selection.openSession(nextProjectId, nextConversationId)
            }}
            projects={projects}
            projectRuns={reconciliation.projectRuns}
            query={navigatorQuery}
            researchSection={projectId ? (
              <>
                <WorkspaceNav
                  active={
                    dmView ? 'dm'
                      : channelView ? 'general'
                        : workView ? 'board'
                          : resourcesSelection ? 'resources'
                            : membersSelection ? 'members'
                              : researchId ? 'question' : 'sessions'
                  }
                  members={roster.roster?.members.filter((member) => member.state !== 'removed') ?? []}
                  needsYouDrafts={taskBoard.drafts}
                  needsYouSessions={attentionSessions.filter((item) => item.project_id === projectId)}
                  needsYouTasks={needsYouTasks}
                  taskCount={taskBoard.board?.total ?? 0}
                  t={t}
                  onOpen={(view) => {
                    if (view === 'general') setChannelSelection({ projectId, threadId: null })
                    else if (view === 'board') setWorkSelection({ projectId })
                    else if (view === 'resources') setViewState({ kind: 'resources', projectId })
                    else setViewState({ kind: 'members', projectId })
                    if (narrowLayout) setSessionSidebarOpen(false)
                  }}
                  onOpenDm={(member) => void openDm(member)}
                  onOpenMember={(member) => {
                    setViewState({ kind: 'members', projectId, memberId: member.id })
                    if (narrowLayout) setSessionSidebarOpen(false)
                  }}
                  onOpenDraft={(draft) => {
                    // A proposal is discussed where it was made: in General, with its detail beside it.
                    setChannelSelection({ projectId, threadId: null, task: draft.id })
                    if (narrowLayout) setSessionSidebarOpen(false)
                  }}
                  onOpenSession={(item) => {
                    showSessions()
                    selection.openSession(item.project_id, item.id)
                  }}
                  onOpenTask={(task) => {
                    setWorkSelection({ projectId, task: task.id })
                    if (narrowLayout) setSessionSidebarOpen(false)
                  }}
                />
                <details className="kubecode-history-nav" open={researchId !== null || Boolean(channelView?.threadId)}>
                  <summary>{t('kubecode.nav.history')}</summary>
                  <ChannelNavigator
                    active={false}
                    onOpen={() => setChannelSelection({ projectId, threadId: null })}
                    onOpenThread={(threadId) => setChannelSelection({ projectId, threadId })}
                    t={t}
                    threads={channelThreads.threads}
                    threadsOnly
                  />
                  <ResearchNavigator
                    activeResearchId={researchId}
                    items={research.items}
                    onNew={() => setResearchDialog(true)}
                    onReload={research.reload}
                    onSelect={(nextResearchId) => setResearchSelection({ projectId, researchId: nextResearchId })}
                    status={research.status}
                    t={t}
                  />
                </details>
              </>
            ) : null}
            t={t}
            teams={teams}
            wechat={wechatBinding}
          />
        )}

        <div className="kubecode-main-stack" ref={mainStackRef}>
          <div className="kubecode-session-context-row">
            {workView && projectId ? (
              <div className="kubecode-with-detail" data-detail={Boolean(workView.task)}>
                <TaskBoardView
                  board={taskBoard.board}
                  drafts={taskBoard.drafts}
                  selectedId={workView.task ?? null}
                  status={taskBoard.status}
                  t={t}
                  onClose={showSessions}
                  onOpenDraft={(draft) => setChannelSelection({ projectId, threadId: null, task: draft.id })}
                  onOpenTask={(card) => setWorkSelection({ projectId, task: card.id })}
                  onReload={taskBoard.reload}
                />
                {workView.task && taskPane(
                  workView.task,
                  () => setWorkSelection({ projectId, task: null }),
                )}
              </div>
            ) : dmView && projectId ? (
              <DmPane
                api={api}
                connectionState={reconciliation.connectionState}
                events={reconciliation.workspaceEvents}
                key={dmView.member.id}
                member={dmView.member}
                projectId={projectId}
                research={research.items}
                t={t}
                onClose={showSessions}
              />
            ) : resourcesSelection && projectId ? (
              <ResourcesView
                api={api}
                canOpen={(reference) => ['research', 'session', 'thread', 'channel', 'work'].includes(reference.kind)}
                projectId={projectId}
                t={t}
                onClose={showSessions}
                onOpen={(reference) => {
                  if (reference.kind === 'research') {
                    setChannelSelection({ projectId, threadId: null, task: reference.id })
                  }
                  else if (reference.kind === 'thread') setChannelSelection({ projectId, threadId: reference.id })
                  else if (reference.kind === 'channel') setChannelSelection({ projectId, threadId: null })
                  else if (reference.kind === 'work') setWorkSelection({ projectId })
                  else if (reference.kind === 'session') {
                    showSessions()
                    selection.openSession(projectId, reference.id)
                  }
                }}
              />
            ) : membersSelection && projectId ? (
              <div className="kubecode-with-detail" data-detail={profileMember !== null}>
                <MembersView
                  agents={agents}
                  api={api}
                  connectionState={reconciliation.connectionState}
                  defaults={memberDefaults}
                  events={reconciliation.workspaceEvents}
                  projectId={projectId}
                  t={t}
                  onClose={showSessions}
                  onDefaultsLoaded={setMemberDefaults}
                  onOpenDm={(member) => void openDm(member)}
                  onOpenMember={(member) => setViewState({ kind: 'members', projectId, memberId: member.id })}
                />
                {profileMember && (
                  <MemberProfile
                    member={profileMember}
                    t={t}
                    onClose={() => setViewState({ kind: 'members', projectId, memberId: null })}
                    onOpenDm={(member) => void openDm(member)}
                  />
                )}
              </div>
            ) : channelView && projectId ? (
              <ChannelWorkspace
                api={api}
                connectionState={reconciliation.connectionState}
                conversations={sessionCatalog}
                detail={channelView.task ? taskPane(
                  channelView.task,
                  () => patchChannel({ task: null }),
                ) : null}
                events={reconciliation.workspaceEvents}
                filter={channelView.filter ?? null}
                focusMessageId={channelView.message ?? null}
                initialThreadId={channelView.threadId}
                key={projectId}
                tasksOnBoard={tasksOnBoard}
                onClose={showSessions}
                onFilterChange={(filter) => patchChannel({ filter })}
                onOpenResearch={(nextResearchId) => patchChannel({ task: nextResearchId })}
                onOpenSession={(nextConversationId) => {
                  showSessions()
                  selection.openSession(projectId, nextConversationId)
                }}
                onOpenTask={(taskId, messageId) => patchChannel({ task: taskId, message: messageId })}
                onOpenWork={(filter) => setWorkSelection({
                  projectId,
                  task: channelThreads.threads.find((thread) => thread.id === filter.thread_id)?.research_id ?? null,
                })}
                onThreadChange={(threadId) => patchChannel({ threadId })}
                projectId={projectId}
                research={research.items}
                t={t}
              />
            ) : researchId && projectId ? (
              <ResearchWorkspace
                agents={agents}
                api={api}
                connectionState={reconciliation.connectionState}
                conversations={sessionCatalog}
                events={reconciliation.workspaceEvents}
                key={researchId}
                onClose={showSessions}
                onConversationCreated={handleConversationCreated}
                onOpenSession={(nextConversationId) => {
                  showSessions()
                  selection.openSession(projectId, nextConversationId)
                }}
                onOpenBoard={(filter) => setWorkSelection({ projectId, task: filter.research_id ?? null })}
                onOpenThread={(threadId) => {
                  setResearchSelection(null)
                  setChannelSelection({ projectId, threadId })
                }}
                projectId={projectId}
                researchId={researchId}
                t={t}
                teams={teams}
              />
            ) : (
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
                onCommandPaletteSessionChange={setCommandPaletteSession}
                onNewSession={() => setSessionDialog(true)}
                onOpenAgentSettings={() => {
                  setSettingsSection('agents')
                  setSettingsOpen(true)
                }}
                onOpenPlan={() => {
                  setContextOpen(true)
                  if (narrowLayout) setSessionSidebarOpen(false)
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
                terminalContextSources={terminalContextSources}
                titlebarTarget={titlebarTarget}
                onSelectTeamMember={setConversationId}
                workspaceEvents={reconciliation.workspaceEvents}
                key={conversationId ?? projectId ?? 'no-project'}
              />
            )}
            {contextVisible && (
              <>
                <ResizeHandle onResize={resizeContext} />
                <ContextWorkbench
                  api={api}
                  autoSave={editorPreferences.autoSave}
                  connectionState={reconciliation.connectionState}
                  planEntries={activeSessionPlan}
                  planRevealVersion={planRevealVersion}
                  projectName={project?.name ?? undefined}
                  projectId={projectId}
                  t={t}
                  width={contextWidth}
                  workspaceEvents={reconciliation.workspaceEvents}
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
                onContextSourcesChange={setTerminalContextSources}
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
        events={reconciliation.workspaceEvents}
        onOpenSession={(nextProjectId, nextConversationId) => {
          showSessions()
          selection.openSession(nextProjectId, nextConversationId)
        }}
        preferences={notifications}
        projects={projects}
      />
      {notificationOnboardingOpen && (
        <aside className="kubecode-notification-onboarding" role="status">
          <Icon role="identity" source={RiNotification3Fill} />
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

      <GlobalCommandPalette
        catalog={commandPaletteSession?.catalog ?? null}
        catalogStatus={commandPaletteSession?.catalogStatus ?? 'ready'}
        hostActions={commandPaletteHostActions}
        onCatalogItem={runCommandPaletteCatalogItem}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const skipRestore = commandPaletteSkipRestoreRef.current
          commandPaletteSkipRestoreRef.current = false
          if (!skipRestore) {
            window.requestAnimationFrame(() => commandPaletteReturnFocusRef.current?.focus())
          }
        }}
        onHostAction={runCommandPaletteHostAction}
        onOpenChange={setCommandPaletteOpen}
        open={commandPaletteOpen}
        sessionDisabledReason={commandPaletteSession?.writable
          ? null
          : t('kubecode.commandPaletteNoWritableSession')}
        sessionWritable={commandPaletteSession?.writable ?? false}
        t={t}
      />

      <ProjectDialog
        api={api}
        open={projectDialog}
        onOpenChange={setProjectDialog}
        onProject={(created) => {
          setProjects((current) => [...current, created])
          selection.selectProject(created.id)
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
      <NewResearchDialog
        api={api}
        open={researchDialog}
        onCreated={(created) => {
          research.reload()
          if (projectId) {
            setChannelSelection(null)
            setResearchSelection({ projectId, researchId: created.id })
          }
        }}
        onOpenChange={setResearchDialog}
        projectId={projectId}
        t={t}
      />
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
      <SettingsDialog
        api={api}
        agentPreferences={agentPreferences}
        agents={agents}
        agentsRefreshing={agentsRefreshing}
        appearance={appearance}
        editorPreferences={editorPreferences}
        notifications={notifications}
        notificationPermission={browserPermission}
        notificationTestStatus={preferences.notificationTestStatus}
        activeProjectId={projectId}
        connectionState={reconciliation.connectionState}
        key={settingsSection}
        open={settingsOpen}
        requestedSection={settingsSection}
        onOpenMemberDm={(member) => {
          if (!projectId) return
          void api.openMemberDm(projectId, member.id).then((opened) => {
            // The researcher may have gone elsewhere while it opened.
            if (projectIdRef.current !== projectId) return
            setResearchSelection(null)
            setChannelSelection(null)
            setWorkSelection(null)
            setSettingsOpen(false)
            setDmSelection({ projectId, member: opened })
          }).catch((cause) => setError(errorMessage(cause, t('kubecode.error'))))
        }}
        onAppearanceChange={preferences.setAppearance}
        onAgentPreferencesChange={preferences.setAgentPreferences}
        onEditorPreferencesChange={preferences.setEditorPreferences}
        onNotificationsChange={preferences.setNotifications}
        onOpenChange={setSettingsOpen}
        onRequestNotificationPermission={requestNotificationPermission}
        onRefreshAgents={refreshAgents}
        onTestNotification={preferences.sendTestNotification}
        t={t}
        wechatBinding={wechatBinding}
        wechatConversations={sessionCatalog}
        wechatProjects={projects}
        workspaceEvents={reconciliation.workspaceEvents}
      />
    </main>
    </SystemMessageProvider>
  )
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

function notificationBody(
  t: Translator,
  category: NotificationCategory,
  projectName: string,
): string {
  if (category === 'attention') return t('kubecode.notificationAttentionBody', { project: projectName })
  if (category === 'error') return t('kubecode.notificationErrorBody', { project: projectName })
  return t('kubecode.notificationCompletionBody', { project: projectName })
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
