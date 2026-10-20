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
import { MembersView } from '../members/MembersView'
import { memberDirectory, MemberDirectoryContext } from '../members/memberDirectory'
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
import {
  KubecodeApi,
  type AgentRun,
  type Conversation,
  type Member,
  type MemberDefaults,
  type Project,
  type ProjectContextRef,
  type TeamSnapshot,
  type TerminalInfo,
} from '../api'
import { TerminalWorkspace, type TerminalContextSource } from '../TerminalWorkspace'
import { SystemMessageProvider } from '../SystemMessageNotice'
import { WorkspaceNotificationBridge } from '../WorkspaceNotificationBridge'
import type { PreferenceStorage } from '../preferenceStorage'
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
import { WorkspaceNav } from './WorkspaceNav'
import { InspectorServicesContext, type InspectorServices } from './inspector/inspectorContext'
import { InspectorPane } from './inspector/InspectorPane'
import { INSPECTOR_PANELS } from './inspector/inspectorPanels'
import { useInspectorPresentation } from './inspector/useInspectorPresentation'
import { WithInspector } from './inspector/WithInspector'
import type { InspectMode, InspectorEntry } from './location/inspector'
import { needsYouFromCurrentSources, type NeedsYouTarget } from './location/needsYou'
import { locationFromRoute, routeFromLocation } from './location/locationRoute'
import { createPlaceMemory, placeKey, type Landing, type ReadingPosition } from './location/placeMemory'
import { PlaceMemoryProvider } from './location/PlaceMemoryProvider'
import { inspectorTargetForReference } from './location/references'
import { useDmTarget } from './location/useDmTarget'
import { useWorkspaceLocation, type LocationDispatchOptions } from './location/useWorkspaceLocation'
import {
  WorkspaceNavigationContext,
  type OpenPlaceOptions,
  type WorkspaceNavigation,
} from './location/WorkspaceNavigation'
import {
  hostsInspector,
  locationOf,
  pickInitialWorkspace,
  viewKeyOf,
  type GeneralPatch,
  type LocationAction,
  type Place,
  type PlaceTarget,
} from './location/workspaceLocation'
import { useWorkspaceRouteSync } from './useWorkspaceRouteSync'
import { parseWorkspaceRoute, routeHash, type WorkspaceRoute } from './workspaceRoute'
import { useProjectSelection } from './useProjectSelection'
import { useWorkbenchPreferences } from './useWorkbenchPreferences'
import { useWorkspaceBootstrap, type SessionsLoad } from './useWorkspaceBootstrap'
import { useWeChatBinding } from './useWeChatBinding'
import { useWorkspaceReconciliation } from './useWorkspaceReconciliation'
import { togglePanel } from './panelToggles'
import { WorkbenchTitlebar } from './WorkbenchTitlebar'
import { mergeConversations, upsertConversation } from './sessionCatalog'

const browserApi = new KubecodeApi()

const focusSessionSearchTarget: { current: (() => void) | null } = { current: null }

const NO_MEMBERS: Member[] = []

/** Where the remembered places live; none where the browser refuses storage. */
function browserStorage(): PreferenceStorage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

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
  const [projectDialog, setProjectDialog] = useState(false)
  const [sessionDialog, setSessionDialog] = useState(false)
  const [researchDialog, setResearchDialog] = useState(false)
  const [conversationsLoadedFor, setConversationsLoadedFor] = useState<SessionsLoad | null>(null)
  // A Workspace's Sessions are read again whenever it becomes the active one.
  const [sessionsProject, setSessionsProject] = useState(projectId)
  if (sessionsProject !== projectId) {
    setSessionsProject(projectId)
    setConversationsLoadedFor(null)
  }
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
  // "History and execution": collapsed unless the researcher opened it.
  const [historyOpen, setHistoryOpen] = useState(false)
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
  // The Workspace the researcher last switched to, so its place is announced.
  const [announcedProjectId, setAnnouncedProjectId] = useState<string | null>(null)
  const narrowLayout = useNarrowWorkbench()

  // -- Where the researcher is (ADR 0228): one location per Workspace -----------------------
  const [locationStorage] = useState(browserStorage)
  const workspaceLocation = useWorkspaceLocation(projectId, locationStorage)
  const { dispatch: dispatchLocation, flush: flushLocation, location, peek: peekLocation } = workspaceLocation
  const { place } = location
  // What a place keeps besides its address (drafts, scroll), for the life of the page.
  const [placeMemory] = useState(createPlaceMemory)
  // How General is arrived at next: a link or a closed detail focuses the message;
  // coming back from the navigation on a wide screen leaves focus where it is.
  const [landing, setLanding] = useState<Landing>('focus')
  // Files and Git are a column beside Sessions; beside the research views they
  // open when asked for and are gone again when the view is left.
  const onSessionsSurface = !projectId || place.view === 'sessions'
  const contextVisible = onSessionsSurface ? contextOpen : researchToolsOpen
  const setContextVisible = useCallback((open: boolean | ((current: boolean) => boolean)) => {
    if (onSessionsSurface) setContextOpen(open)
    else setResearchToolsOpen(open)
  }, [onSessionsSurface])

  const workspaceRef = useRef<HTMLDivElement>(null)
  const mainStackRef = useRef<HTMLDivElement>(null)
  const contextRowRef = useRef<HTMLDivElement>(null)
  const navigatorSearchRef = useRef<HTMLInputElement>(null)
  const commandPaletteReturnFocusRef = useRef<HTMLElement | null>(null)
  const commandPaletteSkipRestoreRef = useRef(false)
  // A `data-focus-key` asked for by a move, focused once it is on screen.
  const pendingFocusRef = useRef<string | null>(null)
  const restoredSessionRef = useRef<string | null>(null)

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
  const placeRef = useRef(place)
  useEffect(() => { placeRef.current = place }, [place])
  const conversationIdRef = useRef(conversationId)
  useEffect(() => { conversationIdRef.current = conversationId }, [conversationId])
  // Where the researcher is reading in each Workspace's General, as it reports it; no render, no route write.
  const readingRef = useRef(new Map<string, ReadingPosition>())
  // What had focus in General when it was last left, per Workspace.
  const leftFocusRef = useRef(new Map<string, ReadingPosition['focus']>())
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
  const defaultChannel = useDefaultChannel(api, projectId)
  const channelThreads = useChannelThreads(
    api,
    projectId,
    defaultChannel.channel?.id ?? null,
    reconciliation.workspaceEvents,
    reconciliation.connectionState,
  )
  // Removed members too: the conversation keeps naming them (ADR 0229 §1).
  const roster = useMembers(api, projectId, reconciliation.workspaceEvents, reconciliation.connectionState, { includeRemoved: true })
  const rosterMembers = roster.roster?.members ?? null
  const directory = useMemo(
    () => memberDirectory(roster.roster, roster.status, roster.reload),
    [roster.reload, roster.roster, roster.status],
  )
  const liveMembers = roster.roster ? directory.live : null
  const taskBoard = useTaskBoard(api, projectId, reconciliation.workspaceEvents, reconciliation.connectionState)
  const tasksOnBoard = useMemo(
    () => new Set((taskBoard.board?.cards ?? []).map((card) => card.id)),
    [taskBoard.board],
  )

  // After a Workspace is removed, the next one is chosen as at startup: the last used, then the first.
  const nextWorkspace = useCallback(
    (remaining: Project[]) => pickInitialWorkspace(remaining, null, peekLocation()),
    [peekLocation],
  )
  const selection = useProjectSelection(api, t, {
    nextWorkspace,
    projectId,
    projects,
    setProjects,
    setProjectId,
    setConversationId,
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
  const { openSession: showSessionIn, selectProject } = selection

  // The startup Workspace: a link's Project, then the last one used, then the first.
  const initialProjectId = useCallback(
    (list: readonly Project[]) => pickInitialWorkspace(list, parseWorkspaceRoute(window.location.hash), peekLocation()),
    [peekLocation],
  )
  const bootstrap = useWorkspaceBootstrap(api, t, {
    projectId,
    applyProjectLayout,
    initialProjectId,
    setProjects,
    setProjectId,
    setSessionSidebarOpen,
    setSessionSidebarWidth,
    setHistoryOpen,
    setProjectRuns: reconciliation.setProjectRuns,
    setWorkspaceCursor,
    setAllConversations,
    setTerminals,
    setTerminalsLoadedForProjectId,
    setConversations,
    setConversationId,
    setConversationsLoadedFor,
    setTeams,
    setError,
  })
  const { agents, agentsRefreshing, layoutHydrated, refreshAgents } = bootstrap
  const attentionSessions = useMemo(
    () => sessionsRequiringInput(reconciliation.projectRuns, sessionCatalog),
    [reconciliation.projectRuns, sessionCatalog],
  )
  /** What waits for the researcher in this Workspace, each saying where it opens. */
  const needsYou = useMemo(() => needsYouFromCurrentSources(
    taskBoard.board?.cards ?? [],
    taskBoard.drafts,
    attentionSessions.filter((item) => item.project_id === projectId),
    t,
  ), [attentionSessions, projectId, t, taskBoard.board, taskBoard.drafts])

  // -- Moving the researcher -----------------------------------------------------------------
  /**
   * Leaving General records where the researcher was reading in its place, as
   * a quiet change, so coming back (or Back, or a reload) lands there again.
   * The address of General's own history entry takes the position at once,
   * before the move away pushes the next place, so Back lands on it too.
   */
  const foldReading = useCallback(() => {
    const current = projectIdRef.current
    if (!current || placeRef.current.view !== 'general') return
    const reading = readingRef.current.get(current)
    if (!reading) return
    readingRef.current.delete(current)
    leftFocusRef.current.set(current, reading.focus)
    if (!reading.atLatest && !reading.messageId) return
    dispatchLocation(
      { type: 'patchGeneral', projectId: current, patch: { message: reading.atLatest ? null : reading.messageId } },
      { history: 'replace' },
    )
    const shown = parseWorkspaceRoute(window.location.hash)
    if (shown?.project === current && shown.view === 'general') {
      const folded = routeFromLocation(current, locationOf(peekLocation(), current))
      window.history.replaceState(window.history.state, '', routeHash(folded))
    }
  }, [dispatchLocation, peekLocation])

  /** A move the researcher made. */
  const move = useCallback((action: LocationAction, options?: LocationDispatchOptions) => {
    const leaving = (action.type === 'go' && action.target.view !== 'general')
      || (action.type === 'enterWorkspace' && action.projectId !== projectIdRef.current)
    if (leaving) foldReading()
    setLanding('focus')
    dispatchLocation(action, { user: true, ...options })
  }, [dispatchLocation, foldReading])

  /**
   * Coming back by the navigation: on a wide screen focus stays on it; when
   * the navigation sheet closes on a phone, focus goes to the message being
   * read, or to the composer if that is where the researcher was.
   */
  const landFromNavigation = useCallback((nextProjectId: string) => {
    if (!narrowLayout) setLanding('quiet')
    else setLanding(leftFocusRef.current.get(nextProjectId) === 'composer' ? 'composer' : 'focus')
  }, [narrowLayout])

  // The last reading position is recorded when the page is hidden, and written at once.
  useEffect(() => {
    const onHide = () => {
      foldReading()
      setLanding('quiet')
      flushLocation()
    }
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [flushLocation, foldReading])
  const closeNavigatorSheet = useCallback(() => {
    if (narrowLayout) setSessionSidebarOpen(false)
  }, [narrowLayout])
  const presentation = useInspectorPresentation(contextRowRef, {
    narrowLayout,
    reservedWidth: contextVisible ? contextWidth : 0,
  })

  const openPlace = useCallback((target: PlaceTarget, options: OpenPlaceOptions = {}) => {
    if (!projectId) return
    const keep = options.inspector === 'keep' || (options.carryInspector === 'when-side' && presentation === 'side')
    const inspector = options.inspect
      ? [options.inspect]
      : options.inspector === 'closed' ? [] : keep ? 'keep' : 'remembered'
    move({ type: 'go', projectId, target, inspector })
    if (options.focus) pendingFocusRef.current = options.focus
    closeNavigatorSheet()
  }, [closeNavigatorSheet, move, presentation, projectId])

  const patchGeneral = useCallback((patch: GeneralPatch) => {
    if (projectId) move({ type: 'patchGeneral', projectId, patch })
  }, [move, projectId])

  const inspect = useCallback((entry: InspectorEntry, options: { mode?: InspectMode } = {}) => {
    if (!projectId) return
    const mode = options.mode ?? 'reset'
    // Swapping the top is a quiet change: Back still returns to what was below it.
    move({ type: 'inspect', projectId, entry, mode }, mode === 'replace' ? { history: 'replace' } : undefined)
  }, [move, projectId])

  /** The only way into execution history: the Sessions surface with this Session. */
  const openSession = useCallback((nextConversationId: string, nextProjectId?: string) => {
    const target = nextProjectId ?? projectId
    if (!target) return
    showSessionIn(target, nextConversationId)
    move({ type: 'go', projectId: target, target: { view: 'sessions', conversation: nextConversationId } })
  }, [move, projectId, showSessionIn])

  /** Another Workspace, at the place it was left in (General for one never visited). */
  const enterWorkspace = useCallback((nextProjectId: string, options: { fresh?: boolean } = {}) => {
    closeNavigatorSheet()
    if (nextProjectId === projectId && !options.fresh) return
    move({ type: 'enterWorkspace', projectId: nextProjectId, fresh: options.fresh })
    selectProject(nextProjectId)
    landFromNavigation(nextProjectId)
    setAnnouncedProjectId(nextProjectId)
  }, [closeNavigatorSheet, landFromNavigation, move, projectId, selectProject])

  const openTaskFromMessage = useCallback((taskId: string, messageId: string) => {
    patchGeneral({ message: messageId })
    inspect({ kind: 'task', id: taskId }, { mode: 'reset' })
  }, [inspect, patchGeneral])

  /**
   * A Thread opens beside General with nothing over it. From elsewhere it is
   * not narrowed to a Task General happened to remember; within General the
   * researcher's own filter stays.
   */
  const openThread = useCallback((threadId: string) => {
    const filter = placeRef.current.view === 'general' ? undefined : null
    openPlace({ view: 'general', thread: threadId, filter }, { inspector: 'closed' })
  }, [openPlace])

  /** A work item opens Kanban with its Task, once the work item says which Task that is. */
  const openWork = useCallback((workId: string) => {
    const requested = projectId
    if (!requested) return
    const taskOf = typeof api.workDetail === 'function'
      ? api.workDetail(requested, workId).then((detail) => detail.item.research_id, () => null)
      : Promise.resolve(null)
    void taskOf.then((taskId) => {
      if (projectIdRef.current !== requested) return
      openPlace({ view: 'board' }, taskId ? { inspect: { kind: 'task', id: taskId } } : undefined)
    })
  }, [api, openPlace, projectId])

  /**
   * Every reference chip and Resources row opens here (ADR 0228 §3): a record
   * in the inspector of the view it was chosen in, so General and Resources
   * keep their place beside it.
   */
  const openReference = useCallback((reference: ProjectContextRef) => {
    const target = inspectorTargetForReference(reference)
    if ('inspect' in target) inspect(target.inspect)
    else if ('place' in target) {
      if (target.place.view === 'general' && target.place.thread) openThread(target.place.thread)
      else openPlace(target.place)
    }
    else if ('work' in target) openWork(target.work)
    else openSession(target.session)
  }, [inspect, openPlace, openSession, openThread, openWork])

  /** Opens the private conversation with a member. */
  const openDm = useCallback((member: Member) => {
    openPlace({ view: 'dm', member: member.id })
    setSettingsOpen(false)
  }, [openPlace])

  /** Opens what a Needs-you entry is about, where the entry says. */
  const openNeedsYouTarget = useCallback((target: NeedsYouTarget) => {
    if (target.session) openSession(target.session.conversationId, target.session.projectId)
    else if (target.place) openPlace(target.place, target.inspect ? { inspect: target.inspect } : undefined)
    else if (target.inspect) {
      inspect(target.inspect)
      closeNavigatorSheet()
    }
  }, [closeNavigatorSheet, inspect, openPlace, openSession])

  const navigation = useMemo<WorkspaceNavigation | null>(() => (projectId ? {
    projectId,
    location,
    presentation,
    openPlace,
    patchGeneral,
    inspect,
    openTaskFromMessage,
    openReference,
    openSession,
    switchWorkspace: enterWorkspace,
  } : null), [enterWorkspace, inspect, location, openPlace, openReference, openSession, openTaskFromMessage, patchGeneral, presentation, projectId])

  // Every way the active Workspace changes (a row, a link, a Session elsewhere, a removal) makes it the last used.
  useEffect(() => {
    if (projectId) dispatchLocation({ type: 'enterWorkspace', projectId })
  }, [dispatchLocation, projectId])

  // The places of Workspaces that are no longer registered are forgotten, with their drafts.
  useEffect(() => {
    if (!layoutHydrated) return
    const projectIds = projects.map((item) => item.id)
    dispatchLocation({ type: 'prune', projectIds })
    placeMemory.prune(projectIds)
    for (const known of readingRef.current.keys()) {
      if (!projectIds.includes(known)) readingRef.current.delete(known)
    }
  }, [dispatchLocation, layoutHydrated, placeMemory, projects])

  // A private conversation or a profile of a member who left falls back quietly.
  useEffect(() => {
    if (!projectId || !rosterMembers) return
    dispatchLocation({
      type: 'reconcile',
      projectId,
      facts: {
        memberIds: new Set(rosterMembers.map((member) => member.id)),
        removedMemberIds: new Set(rosterMembers.filter((member) => member.state === 'removed').map((member) => member.id)),
      },
    }, { history: 'replace' })
  }, [dispatchLocation, projectId, rosterMembers])

  // A private conversation is named by its member; the Member comes from the roster or is opened.
  const dmMemberId = place.view === 'dm' ? place.member : null
  const dmTarget = useDmTarget(api, projectId, dmMemberId, liveMembers, {
    rosterFailed: roster.status === 'error',
    onError: (cause) => {
      setError(errorMessage(cause, t('kubecode.error')))
      if (projectId && dmMemberId) {
        dispatchLocation(
          { type: 'reconcile', projectId, facts: { removedMemberIds: new Set([dmMemberId]) } },
          { history: 'replace' },
        )
      }
    },
  })

  // Execution history remembers its Session: it reopens once this Workspace's
  // Sessions are read, if it is still one of them, and General otherwise. A
  // Session chosen there afterwards is what it remembers. Sessions that could
  // not be read say nothing about what exists, so nothing is forgotten then.
  const sessionsReady = conversationsLoadedFor !== null && conversationsLoadedFor.projectId === projectId
  const sessionsRead = sessionsReady && conversationsLoadedFor.ok
  const rememberedSession = place.view === 'sessions' ? place.conversation ?? null : null
  const sessionAwaited = rememberedSession !== null
    && rememberedSession !== conversationId
    && (!sessionsReady || conversations.some((item) => item.id === rememberedSession))
  useEffect(() => {
    if (!projectId || place.view !== 'sessions') {
      restoredSessionRef.current = null
      return
    }
    if (!sessionsReady) return
    const wanted = place.conversation ?? null
    const key = `${projectId}|${wanted ?? ''}`
    if (restoredSessionRef.current !== key) {
      restoredSessionRef.current = key
      if (wanted && wanted !== conversationId) {
        if (conversations.some((item) => item.id === wanted)) showSessionIn(projectId, wanted)
        else if (sessionsRead) {
          dispatchLocation({
            type: 'reconcile',
            projectId,
            facts: { conversationIds: new Set(conversations.map((item) => item.id)) },
          }, { history: 'replace' })
        }
        return
      }
    }
    if (conversationId && conversationId !== wanted && conversations.some((item) => item.id === conversationId)) {
      dispatchLocation({ type: 'patchSessions', projectId, conversation: conversationId }, { history: 'replace' })
    }
  }, [conversationId, conversations, dispatchLocation, place, projectId, sessionsRead, sessionsReady, showSessionIn])

  // A move may ask for something to be focused once it is on screen.
  useEffect(() => {
    const key = pendingFocusRef.current
    if (!key) return
    const target = Array.from(document.querySelectorAll<HTMLElement>('[data-focus-key]'))
      .find((element) => element.dataset.focusKey === key)
    if (!target) return
    pendingFocusRef.current = null
    target.focus({ preventScroll: true })
  })

  // -- Where the researcher is, as a route (ADR 0224, ADR 0228) ------------------------------
  const currentRoute = useMemo<WorkspaceRoute>(
    () => routeFromLocation(projectId, location, place.view === 'sessions' ? conversationId : null),
    [conversationId, location, place.view, projectId],
  )

  const linkFollowedRef = useRef(false)
  const applyRoute = useCallback((route: WorkspaceRoute): boolean => {
    const target = route.project ?? projectIdRef.current
    // An unknown Project cannot be honoured: the link is abandoned at once.
    if (!target || !projects.some((item) => item.id === target)) return false
    if (target !== projectIdRef.current) selectProject(target)
    dispatchLocation({ type: 'applyRoute', projectId: target, location: locationFromRoute(route) })
    if (route.view === 'sessions' && route.conversation) showSessionIn(target, route.conversation)
    // A link followed after load is a move like any other: on a phone the
    // navigation sheet makes way for the place. The first link only sets where
    // the page opens, so the sheet stays as the layout left it.
    if (linkFollowedRef.current) closeNavigatorSheet()
    return true
  }, [closeNavigatorSheet, dispatchLocation, projects, selectProject, showSessionIn])
  const routeSync = useWorkspaceRouteSync({
    apply: applyRoute,
    current: currentRoute,
    ready: layoutHydrated && projectId !== null,
    ignoreInitialLink: workspaceLocation.userMoved,
    historyMode: workspaceLocation.takeHistoryMode,
  })
  // Once the page has opened where its address said, later links are moves.
  const routeReady = layoutHydrated && projectId !== null && !routeSync.pending
  useEffect(() => {
    if (routeReady) linkFollowedRef.current = true
  }, [routeReady])

  useEffect(() => {
    if (!layoutHydrated) return
    writeWorkbenchNavigatorLayout(localStorage, {
      historyOpen,
      navigatorOpen: sessionSidebarOpen,
      navigatorWidth: sessionSidebarWidth,
    })
  }, [historyOpen, layoutHydrated, sessionSidebarOpen, sessionSidebarWidth])

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
      focusSessionSearchTarget.current?.()
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

  // The Session search lives in execution history: the navigation and that
  // section open first, and the search is focused once they are on screen.
  useEffect(() => {
    focusSessionSearchTarget.current = () => {
      setSessionSidebarOpen(true)
      if (narrowLayout) setContextVisible(false)
      setHistoryOpen(true)
      window.requestAnimationFrame(() => {
        navigatorSearchRef.current?.focus()
        navigatorSearchRef.current?.select()
      })
    }
  }, [narrowLayout, setContextVisible])

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
    if (onSessionsSurface) setResearchToolsOpen(false)
  }, [onSessionsSurface])

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

  /** A new Session (or a Task's discussion) opens in execution history. */
  const handleConversationCreated = useCallback((created: Conversation) => {
    setConversations((current) => upsertConversation(current, created))
    setAllConversations((current) => upsertConversation(current, created))
    setConversationId(created.id)
    const target = created.project_id ?? projectIdRef.current
    if (target) move({ type: 'go', projectId: target, target: { view: 'sessions', conversation: created.id } })
  }, [move])

  /**
   * A removed Session is forgotten wherever it was remembered. Removing the one
   * on screen goes to the Workspace's General: never into another Session.
   */
  const handleConversationRemoved = useCallback((removedId: string) => {
    const current = projectIdRef.current
    const onScreen = placeRef.current.view === 'sessions' && conversationIdRef.current === removedId
    setConversations((list) => list.filter((item) => item.id !== removedId))
    setConversationId((selected) => (selected === removedId ? null : selected))
    setAllConversations((list) => list.filter((item) => item.id !== removedId))
    if (!current) return
    if (onScreen) dispatchLocation({ type: 'go', projectId: current, target: { view: 'general' } }, { history: 'replace' })
    dispatchLocation(
      { type: 'reconcile', projectId: current, facts: { removedConversationIds: new Set([removedId]) } },
      { history: 'replace' },
    )
  }, [dispatchLocation])

  const handleConversationUpdated = useCallback((updated: Conversation) => {
    setConversations((current) => upsertConversation(current, updated))
    setAllConversations((current) => upsertConversation(current, updated))
  }, [])

  const inspectorServices = useMemo<InspectorServices>(() => ({
    agents,
    api,
    connectionState: reconciliation.connectionState,
    events: reconciliation.workspaceEvents,
    roster: rosterMembers ?? NO_MEMBERS,
    sessionCatalog,
    t,
    teams,
    onConversationCreated: handleConversationCreated,
  }), [agents, api, handleConversationCreated, reconciliation.connectionState, reconciliation.workspaceEvents, rosterMembers, sessionCatalog, t, teams])

  /** What a place is called: in the inspector's "Back to …" and the switch announcement. */
  const placeName = (shown: Place): string => {
    switch (shown.view) {
      case 'general': return t('kubecode.channel.general')
      case 'board': return t('kubecode.nav.board')
      case 'resources': return t('kubecode.nav.resources')
      case 'members': return t('kubecode.nav.members')
      case 'dm':
        return rosterMembers?.find((member) => member.id === shown.member)?.name
          ?? dmTarget.member?.name
          ?? t('kubecode.nav.members')
      case 'sessions': return t('kubecode.sessionsLabel')
      case 'question':
        return research.items.find((item) => item.id === shown.question)?.title ?? t('kubecode.nav.history')
    }
  }

  /** The inspector of the view on screen, beside it or over it; nothing while it is closed. */
  const inspectorPane = projectId && hostsInspector(place) && location.inspector.length > 0 ? (
    <InspectorPane
      key={viewKeyOf(place)}
      originLabel={placeName(place)}
      panels={INSPECTOR_PANELS}
      presentation={presentation}
      projectId={projectId}
      stack={location.inspector}
      t={t}
      onBack={() => move({ type: 'inspectorBack', projectId })}
      onClose={() => move({ type: 'inspectorClose', projectId })}
      onPush={(entry) => inspect(entry, { mode: 'push' })}
      onReplace={(entry) => inspect(entry, { mode: 'replace' })}
    />
  ) : null
  /** The place named in the title bar; the Sessions surface titles itself. */
  const placeLabel = projectId && place.view !== 'sessions' ? placeName(place) : null
  // Execution history stays open while it holds what is on screen or being searched.
  const historyPinned = place.view === 'sessions'
    || place.view === 'question'
    || (place.view === 'general' && Boolean(place.thread))
    || navigatorQuery.trim() !== ''
  const historyShown = historyOpen || historyPinned
  const inspectorBottom = location.inspector[0]
  const boardTask = inspectorBottom?.kind === 'task' ? inspectorBottom.id : null
  const announcement = announcedProjectId !== null && announcedProjectId === projectId && project
    ? t('kubecode.nav.placeAnnouncement', { workspace: project.name, place: placeName(place) })
    : ''
  // A link or a remembered Session is still being reached: never show another place meanwhile.
  // With no Project once loaded, nothing can be reached and the first-run screen shows.
  const arriving = (!layoutHydrated && error === null)
    || (projectId !== null && (routeSync.pending || sessionAwaited))

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

  /** Execution history: the Sessions surface, or the first-run screen without a Project. */
  const sessionsSurface = (
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
  )

  return (
    <SystemMessageProvider detailsLabel={t('kubecode.details')} dismissLabel={t('window.close')}>
    <PlaceMemoryProvider memory={placeMemory}>
    <WorkspaceNavigationContext.Provider value={navigation}>
    <MemberDirectoryContext.Provider value={directory}>
    <InspectorServicesContext.Provider value={inspectorServices}>
    <main className="kubecode-app">
      <p className="sr-only" role="status">{announcement}</p>
      <WorkbenchTitlebar
        attentionSessions={attentionSessions}
        connectionState={reconciliation.connectionState}
        contextOpen={contextVisible}
        conversation={conversation}
        error={error}
        lastSuccessfulSyncAt={reconciliation.lastSuccessfulSyncAt}
        locale={locale}
        narrowLayout={narrowLayout}
        onContextOpenChange={setContextVisible}
        onOpenSession={(nextProjectId, nextConversationId) => openSession(nextConversationId, nextProjectId)}
        onRetryConnection={reconciliation.retry}
        onSessionSidebarOpenChange={setSessionSidebarOpen}
        onTerminalOpenChange={setTerminalOpen}
        placeLabel={placeLabel}
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
            historyOpen={historyShown}
            historyPinned={historyPinned}
            historySection={projectId ? (
              <>
                <ChannelNavigator
                  active={false}
                  onOpen={() => openPlace({ view: 'general' })}
                  onOpenThread={openThread}
                  t={t}
                  threads={channelThreads.threads}
                  threadsOnly
                />
                <ResearchNavigator
                  activeResearchId={place.view === 'question' ? place.question : null}
                  items={research.items}
                  onNew={() => setResearchDialog(true)}
                  onReload={research.reload}
                  onSelect={(nextResearchId) => openPlace({ view: 'question', question: nextResearchId })}
                  status={research.status}
                  t={t}
                />
              </>
            ) : null}
            navigatorWidth={sessionSidebarWidth}
            onAddProject={() => setProjectDialog(true)}
            onConversationCreated={handleConversationCreated}
            onConversationRemoved={handleConversationRemoved}
            onConversationUpdated={handleConversationUpdated}
            onError={(cause) => setError(errorMessage(cause, t('kubecode.error')))}
            onHistoryOpenChange={setHistoryOpen}
            onNewSession={(nextProjectId) => {
              if (nextProjectId !== projectId) enterWorkspace(nextProjectId)
              setSessionDialog(true)
            }}
            onOpenSettings={() => {
              setSettingsSection('general')
              setSettingsOpen(true)
            }}
            onProjectDelete={(nextProjectId) => void selection.deleteProject(
              projects.find((candidate) => candidate.id === nextProjectId),
            )}
            onProjectWorkspacesToggle={(nextProjectId) => {
              const selectedProject = projects.find((candidate) => candidate.id === nextProjectId)
              if (!selectedProject) return
              // Disabling asks in a dialog about the Workspace it concerns, so that Workspace is entered first.
              if (selectedProject.workspaces_enabled) enterWorkspace(nextProjectId)
              void selection.setProjectWorkspacesEnabled(!selectedProject.workspaces_enabled, selectedProject)
            }}
            onQueryChange={setNavigatorQuery}
            onResize={resizeSessionSidebar}
            onSelect={(nextProjectId, nextConversationId) => openSession(nextConversationId, nextProjectId)}
            onWorkspaceSelect={(nextProjectId) => enterWorkspace(nextProjectId)}
            projects={projects}
            projectRuns={reconciliation.projectRuns}
            query={navigatorQuery}
            searchRef={navigatorSearchRef}
            t={t}
            teams={teams}
            wechat={wechatBinding}
            workspaceSection={projectId ? (
              <WorkspaceNav
                active={place.view === 'sessions' || place.view === 'question' ? null : viewKeyOf(place)}
                members={liveMembers ?? NO_MEMBERS}
                needsYou={needsYou}
                taskCount={taskBoard.board?.total ?? 0}
                t={t}
                onInspectMember={(memberId) => {
                  inspect({ kind: 'member', id: memberId })
                  closeNavigatorSheet()
                }}
                onOpen={(view) => {
                  openPlace({ view })
                  landFromNavigation(projectId)
                }}
                onOpenDm={(memberId) => openPlace({ view: 'dm', member: memberId })}
                onOpenTarget={openNeedsYouTarget}
              />
            ) : null}
          />
        )}

        <div className="kubecode-main-stack" ref={mainStackRef}>
          <div
            className="kubecode-session-context-row"
            data-inspector-layout={presentation}
            ref={contextRowRef}
          >
            {arriving ? (
              <div className="kubecode-empty-small" role="status">{t('kubecode.nav.opening')}</div>
            ) : !projectId ? sessionsSurface : place.view === 'board' ? (
              <WithInspector inspector={inspectorPane} presentation={presentation}>
                <TaskBoardView
                  board={taskBoard.board}
                  drafts={taskBoard.drafts}
                  scrollKey={placeKey.view(projectId, 'board')}
                  selectedId={boardTask}
                  status={taskBoard.status}
                  t={t}
                  onOpenDraft={(draft) => openPlace({ view: 'general' }, { inspect: { kind: 'task', id: draft.id } })}
                  onOpenTask={(card) => inspect({ kind: 'task', id: card.id })}
                  onReload={taskBoard.reload}
                />
              </WithInspector>
            ) : place.view === 'dm' ? (
              dmTarget.member ? (
                <WithInspector inspector={inspectorPane} presentation={presentation}>
                  <DmPane
                    api={api}
                    connectionState={reconciliation.connectionState}
                    events={reconciliation.workspaceEvents}
                    key={dmTarget.member.id}
                    member={dmTarget.member}
                    projectId={projectId}
                    research={research.items}
                    t={t}
                  />
                </WithInspector>
              ) : (
                <div className="kubecode-empty-small" role="status">{t('kubecode.nav.opening')}</div>
              )
            ) : place.view === 'resources' ? (
              <WithInspector inspector={inspectorPane} presentation={presentation}>
                <ResourcesView
                  api={api}
                  projectId={projectId}
                  stateKey={placeKey.view(projectId, 'resources')}
                  t={t}
                  onOpen={openReference}
                />
              </WithInspector>
            ) : place.view === 'members' ? (
              <WithInspector inspector={inspectorPane} presentation={presentation}>
                <MembersView
                  agents={agents}
                  api={api}
                  connectionState={reconciliation.connectionState}
                  defaults={memberDefaults}
                  events={reconciliation.workspaceEvents}
                  projectId={projectId}
                  scrollKey={placeKey.view(projectId, 'members')}
                  t={t}
                  onDefaultsLoaded={setMemberDefaults}
                  onOpenDm={openDm}
                  onOpenMember={(member) => inspect({ kind: 'member', id: member.id })}
                />
              </WithInspector>
            ) : place.view === 'general' ? (
              <ChannelWorkspace
                api={api}
                connectionState={reconciliation.connectionState}
                conversations={sessionCatalog}
                detail={inspectorPane}
                detailCovers={presentation === 'screen'}
                events={reconciliation.workspaceEvents}
                filter={place.filter ?? null}
                focusMessageId={place.message ?? null}
                initialThreadId={place.thread ?? null}
                key={projectId}
                landing={landing}
                locale={locale}
                onReadingPositionChange={(position) => readingRef.current.set(projectId, position)}
                tasksOnBoard={taskBoard.board ? tasksOnBoard : undefined}
                onFilterChange={(filter) => patchGeneral({ filter })}
                onOpenReference={openReference}
                onOpenTask={openTaskFromMessage}
                onOpenWork={(filter) => {
                  const taskId = channelThreads.threads.find((item) => item.id === filter.thread_id)?.research_id
                  openPlace({ view: 'board' }, taskId ? { inspect: { kind: 'task', id: taskId } } : undefined)
                }}
                onThreadChange={(threadId) => patchGeneral({ thread: threadId })}
                projectId={projectId}
                research={research.items}
                t={t}
              />
            ) : place.view === 'question' ? (
              <ResearchWorkspace
                agents={agents}
                api={api}
                connectionState={reconciliation.connectionState}
                conversations={sessionCatalog}
                events={reconciliation.workspaceEvents}
                key={place.question}
                onConversationCreated={handleConversationCreated}
                onOpenSession={(nextConversationId) => openSession(nextConversationId)}
                onOpenBoard={(filter) => openPlace({ view: 'board' }, { inspect: { kind: 'task', id: filter.research_id } })}
                onOpenThread={openThread}
                projectId={projectId}
                researchId={place.question}
                t={t}
                teams={teams}
              />
            ) : sessionsSurface}
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
        onOpenSession={(nextProjectId, nextConversationId) => openSession(nextConversationId, nextProjectId)}
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
          // A new Workspace opens in General, with nothing remembered.
          enterWorkspace(created.id, { fresh: true })
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
          openPlace({ view: 'question', question: created.id })
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
        onOpenMemberDm={openDm}
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
    </InspectorServicesContext.Provider>
    </MemberDirectoryContext.Provider>
    </WorkspaceNavigationContext.Provider>
    </PlaceMemoryProvider>
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
