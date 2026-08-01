import { useCallback, useEffect, useState } from 'react'

import type {
  AgentDescriptor,
  AgentRun,
  Conversation,
  KubecodeApi,
  Project,
  TeamSnapshot,
  TerminalInfo,
} from '../api'
import { readWorkbenchNavigatorLayout } from '../workbenchLayout'
import { errorMessage } from './errors'
import { mergeProjectRuns } from './useWorkspaceReconciliation'
import { mergeConversations } from './sessionCatalog'
import type { Translator } from './translator'

type Dispatch<State> = React.Dispatch<React.SetStateAction<State>>

export type WorkspaceBootstrapOptions = {
  projectId: string | null
  applyProjectLayout: (projectId: string) => void
  setProjects: Dispatch<Project[]>
  setProjectId: Dispatch<string | null>
  setSessionSidebarOpen: Dispatch<boolean>
  setSessionSidebarWidth: Dispatch<number>
  setExpandedProjectIds: Dispatch<string[]>
  setProjectRuns: Dispatch<Record<string, AgentRun[]>>
  setWorkspaceCursor: Dispatch<number | null>
  setAllConversations: Dispatch<Conversation[]>
  setTerminals: Dispatch<TerminalInfo[]>
  setTerminalsLoadedForProjectId: Dispatch<string | null>
  setConversations: Dispatch<Conversation[]>
  setConversationId: Dispatch<string | null>
  setTeams: Dispatch<TeamSnapshot[]>
  setError: Dispatch<string | null>
}

export type WorkspaceBootstrapResult = {
  agents: AgentDescriptor[]
  agentsRefreshing: boolean
  layoutHydrated: boolean
  refreshAgents: () => Promise<void>
  setLayoutHydrated: Dispatch<boolean>
}

export function useWorkspaceBootstrap(
  api: KubecodeApi,
  t: Translator,
  options: WorkspaceBootstrapOptions,
) {
  const {
    projectId,
    applyProjectLayout,
    setProjects,
    setProjectId,
    setSessionSidebarOpen,
    setSessionSidebarWidth,
    setExpandedProjectIds,
    setProjectRuns,
    setWorkspaceCursor,
    setAllConversations,
    setTerminals,
    setTerminalsLoadedForProjectId,
    setConversations,
    setConversationId,
    setTeams,
    setError,
  } = options
  const [agents, setAgents] = useState<AgentDescriptor[]>([])
  const [agentsRefreshing, setAgentsRefreshing] = useState(false)
  const [layoutHydrated, setLayoutHydrated] = useState(false)

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
  }, [api, applyProjectLayout, setError, setExpandedProjectIds, setLayoutHydrated, setProjectId, setProjectRuns, setProjects, setSessionSidebarOpen, setSessionSidebarWidth, t])

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
  }, [api, setAllConversations, setError, setWorkspaceCursor, t])

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
  }, [api, projectId, setAllConversations, setConversationId, setConversations, setError, setTeams, setTerminals, setTerminalsLoadedForProjectId, t])

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
  }, [api, setError, t])

  return { agents, agentsRefreshing, layoutHydrated, refreshAgents, setLayoutHydrated }
}
