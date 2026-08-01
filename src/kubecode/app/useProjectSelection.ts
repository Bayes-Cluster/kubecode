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
  setExpandedProjectIds: Dispatch<string[]>
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
    setExpandedProjectIds,
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
    setExpandedProjectIds((current) => (
      current.includes(nextProjectId) ? current : [...current, nextProjectId]
    ))
  }, [applyProjectLayout, setActiveSessionPlan, setConversationId, setConversations, setExpandedProjectIds, setProjectId, setTeams, setTerminals, setTerminalsLoadedForProjectId])

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
  }, [setExpandedProjectIds])

  const deleteProject = useCallback(async (targetProject = project) => {
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
  }, [api, applyProjectLayout, project, projects, setAllConversations, setConversationId, setConversations, setError, setProjectId, setProjectRuns, setProjects, setTeams, setTerminals, setTerminalsLoadedForProjectId, t])

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
    setExpandedProjectIds((current) => (
      current.includes(nextProjectId) ? current : [...current, nextProjectId]
    ))
    setConversationId(nextConversationId)
  }, [applyProjectLayout, projectId, setActiveSessionPlan, setConversationId, setConversations, setExpandedProjectIds, setProjectId, setTerminals, setTerminalsLoadedForProjectId])

  return {
    deleteProject,
    openSession,
    project,
    selectProject,
    setProjectWorkspacesEnabled,
    toggleProjectExpanded,
  }
}
