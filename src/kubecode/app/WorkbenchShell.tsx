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
import { Icon } from '../icons'
import { DisableWorkspacesDialog } from '../DisableWorkspacesDialog'
import { terminalFontStack } from '../appearancePreferences'
import { KubecodeApi, type AgentRun, type Conversation, type Project, type TeamSnapshot, type TerminalInfo } from '../api'
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
import { useProjectSelection } from './useProjectSelection'
import { useWorkbenchPreferences } from './useWorkbenchPreferences'
import { useWorkspaceBootstrap } from './useWorkspaceBootstrap'
import { useWorkspaceReconciliation } from './useWorkspaceReconciliation'
import { togglePanel } from './panelToggles'
import { WorkbenchTitlebar } from './WorkbenchTitlebar'
import { mergeConversations, upsertConversation } from './sessionCatalog'

const browserApi = new KubecodeApi()

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
    if (!narrowLayout || (!sessionSidebarOpen && !contextOpen)) return
    const closeOverlayPanels = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('[role="dialog"]')) return
      setSessionSidebarOpen(false)
      setContextOpen(false)
    }
    document.addEventListener('keydown', closeOverlayPanels)
    return () => document.removeEventListener('keydown', closeOverlayPanels)
  }, [contextOpen, narrowLayout, sessionSidebarOpen])

  useEffect(() => {
    // On narrow layouts, the navigator takes precedence if both overlays are open.
    if (!narrowLayout || !sessionSidebarOpen || !contextOpen) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setContextOpen(false)
  }, [contextOpen, narrowLayout, sessionSidebarOpen])

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

  const commandPaletteHostActions = createHostActionRegistry({
    addProject: () => setProjectDialog(true),
    focusSessionSearch: () => focusSessionSearchTarget.current?.(),
    newSession: () => setSessionDialog(true),
    openSettings: () => {
      setSettingsSection('general')
      setSettingsOpen(true)
    },
    toggleContext: () => {
      setContextOpen((open) => {
        const nextOpen = togglePanel('context', open)
        if (narrowLayout && nextOpen) setSessionSidebarOpen(false)
        return nextOpen
      })
    },
    toggleNavigator: () => {
      setSessionSidebarOpen((open) => {
        const nextOpen = togglePanel('sessions', open)
        if (narrowLayout && nextOpen) setContextOpen(false)
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
        contextOpen={contextOpen}
        conversation={conversation}
        error={error}
        lastSuccessfulSyncAt={reconciliation.lastSuccessfulSyncAt}
        locale={locale}
        narrowLayout={narrowLayout}
        navigatorQuery={navigatorQuery}
        navigatorSearchRef={navigatorSearchRef}
        onContextOpenChange={setContextOpen}
        onNavigatorQueryChange={setNavigatorQuery}
        onOpenSession={selection.openSession}
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
            onProjectSelect={selection.selectProject}
            onProjectToggle={selection.toggleProjectExpanded}
            onProjectWorkspacesToggle={(nextProjectId) => {
              const selectedProject = projects.find((candidate) => candidate.id === nextProjectId)
              if (selectedProject) {
                void selection.setProjectWorkspacesEnabled(!selectedProject.workspaces_enabled, selectedProject)
              }
            }}
            onResize={resizeSessionSidebar}
            onSelect={selection.openSession}
            projects={projects}
            projectRuns={reconciliation.projectRuns}
            query={navigatorQuery}
            t={t}
            teams={teams}
          />
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
            {contextOpen && (
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
        onOpenSession={selection.openSession}
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
        key={settingsSection}
        open={settingsOpen}
        requestedSection={settingsSection}
        onAppearanceChange={preferences.setAppearance}
        onAgentPreferencesChange={preferences.setAgentPreferences}
        onEditorPreferencesChange={preferences.setEditorPreferences}
        onNotificationsChange={preferences.setNotifications}
        onOpenChange={setSettingsOpen}
        onRequestNotificationPermission={requestNotificationPermission}
        onRefreshAgents={refreshAgents}
        onTestNotification={preferences.sendTestNotification}
        t={t}
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
