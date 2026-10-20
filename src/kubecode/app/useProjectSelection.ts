import { useCallback } from 'react'
import { trackEvent } from '@/lib/telemetry'

import type {
  AgentRun,
  Conversation,
  KubecodeApi,
  Project,
  TeamSnapshot,
  TerminalInfo,
} from '../api'
import type { SessionPlanEntry } from '../AgentSessionWorkspace'
import { errorMessage } from './errors'
import type { Translator } from '@/lib/i18n'

type Dispatch<State> = React.Dispatch<React.SetStateAction<State>>

export type ProjectSelectionOptions = {
  projectId: string | null
  projects: Project[]
  setProjects: Dispatch<Project[]>
  setProjectId: Dispatch<string | null>
  setConversationId: Dispatch<string | null>
  setConversations: Dispatch<Conversation[]>
  setTeams: Dispatch<TeamSnapshot[]>
  setTerminals: Dispatch<TerminalInfo[]>
  setTerminalsLoadedForProjectId: Dispatch<string | null>
  setActiveSessionPlan: Dispatch<SessionPlanEntry[]>
  setAllConversations: Dispatch<Conversation[]>
  setProjectRuns: Dispatch<Record<string, AgentRun[]>>
  setDisableWorkspacesOpen: Dispatch<boolean>
  setError: Dispatch<string | null>
  applyProjectLayout: (projectId: string) => void
  /**
   * The Workspace to be in once one is removed, chosen as at startup (ADR
   * 0228: the last one used if it is still registered, then the first).
   */
  nextWorkspace?: (remaining: Project[]) => string | null
}

export function useProjectSelection(
  api: KubecodeApi,
  t: Translator,
  options: ProjectSelectionOptions,
) {
  const {
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
    setProjectRuns,
    setDisableWorkspacesOpen,
    setError,
    applyProjectLayout,
    nextWorkspace,
  } = options

  const project = projects.find((item) => item.id === projectId) ?? null

  const selectProject = useCallback((nextProjectId: string) => {
    setConversationId(null)
    setActiveSessionPlan([])
    setConversations([])
    setTeams([])
    setTerminals([])
    setTerminalsLoadedForProjectId(null)
    applyProjectLayout(nextProjectId)
    setProjectId(nextProjectId)
  }, [applyProjectLayout, setActiveSessionPlan, setConversationId, setConversations, setProjectId, setTeams, setTerminals, setTerminalsLoadedForProjectId])

  const deleteProject = useCallback(async (targetProject = project) => {
    if (!targetProject) return
    try {
      await api.unregisterProject(targetProject.id)
      const remainingProjects = projects.filter((item) => item.id !== targetProject.id)
      const nextProjectId = nextWorkspace ? nextWorkspace(remainingProjects) : remainingProjects[0]?.id ?? null
      setProjects(remainingProjects)
      setProjectRuns((current) => {
        const next = { ...current }
        delete next[targetProject.id]
        return next
      })
      setAllConversations((current) => current.filter((item) => item.project_id !== targetProject.id))
      trackEvent('kubecode_project_removed')
      // Removing another Workspace leaves the one on screen as it is.
      if (nextProjectId === projectId) return
      setConversations([])
      setTeams([])
      setConversationId(null)
      setTerminals([])
      setTerminalsLoadedForProjectId(null)
      if (nextProjectId) applyProjectLayout(nextProjectId)
      setProjectId(nextProjectId)
    } catch (cause) {
      setError(errorMessage(cause, t('kubecode.error')))
    }
  }, [api, applyProjectLayout, nextWorkspace, project, projectId, projects, setAllConversations, setConversationId, setConversations, setError, setProjectId, setProjectRuns, setProjects, setTeams, setTerminals, setTerminalsLoadedForProjectId, t])

  const setProjectWorkspacesEnabled = useCallback(async (enabled: boolean, targetProject = project) => {
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
  }, [api, project, projectId, selectProject, setDisableWorkspacesOpen, setError, setProjects, t])

  const openSession = useCallback((nextProjectId: string, nextConversationId: string) => {
    setActiveSessionPlan([])
    if (nextProjectId !== projectId) {
      applyProjectLayout(nextProjectId)
      setTerminals([])
      setTerminalsLoadedForProjectId(null)
      setConversations([])
      setProjectId(nextProjectId)
    }
    setConversationId(nextConversationId)
  }, [applyProjectLayout, projectId, setActiveSessionPlan, setConversationId, setConversations, setProjectId, setTerminals, setTerminalsLoadedForProjectId])

  return {
    deleteProject,
    openSession,
    project,
    selectProject,
    setProjectWorkspacesEnabled,
  }
}
