import { useCallback, useState } from 'react'
import { trackEvent } from '@/lib/telemetry'

import type {
  AgentRun,
  Conversation,
  KubecodeApi,
  RunStatus,
  TeamSnapshot,
  TerminalInfo,
  WorkspaceEvent,
} from '../api'
import {
  useWorkspaceEventStream,
  type WorkspaceEventBatch,
  type WorkspaceEventOwnership,
  type WorkspaceEventReconciliationRequest,
} from '../useWorkspaceEventStream'
import { errorMessage } from './errors'
import type { Translator } from './translator'

type Dispatch<State> = React.Dispatch<React.SetStateAction<State>>

export type WorkspaceReconciliationOptions = {
  projectId: string | null
  cursor: number | null
  setAllConversations: Dispatch<Conversation[]>
  setConversations: Dispatch<Conversation[]>
  setConversationId: Dispatch<string | null>
  setTeams: Dispatch<TeamSnapshot[]>
  setTerminals: Dispatch<TerminalInfo[]>
  setTerminalsLoadedForProjectId: Dispatch<string | null>
  setError: Dispatch<string | null>
}

export function useWorkspaceReconciliation(
  api: KubecodeApi,
  t: Translator,
  options: WorkspaceReconciliationOptions,
) {
  const {
    projectId,
    cursor,
    setAllConversations,
    setConversations,
    setConversationId,
    setTeams,
    setTerminals,
    setTerminalsLoadedForProjectId,
    setError,
  } = options
  const [projectRuns, setProjectRuns] = useState<Record<string, AgentRun[]>>({})

  const reportOwnedError = useCallback((cause: unknown, ownership: WorkspaceEventOwnership) => {
    if (ownership.isCurrent()) setError(errorMessage(cause, t('kubecode.error')))
  }, [setError, t])

  const handleWorkspaceEventBatch = useCallback((batch: WorkspaceEventBatch) => {
    setProjectRuns((current) => applyWorkspaceRunEvents(current, batch.events))
    setAllConversations((current) => applyWorkspaceConversationEvents(current, batch.events))
    setConversations((current) => applyWorkspaceConversationEvents(current, batch.events))
  }, [setAllConversations, setConversations])

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
      const reconciledRuns = runResult.value
      setProjectRuns((current) => applyWorkspaceRunEvents({
        ...current,
        [activeProjectId]: reconciledRuns,
      }, replayEvents))
    }
  }, [api, reportOwnedError, setAllConversations, setConversationId, setConversations, setProjectRuns, setTeams, setTerminals, setTerminalsLoadedForProjectId])

  const {
    connectionState,
    diagnostic: workspaceEventDiagnostic,
    events: workspaceEvents,
    lastSuccessfulSyncAt,
    retry: retryWorkspaceConnection,
  } = useWorkspaceEventStream({
    activeProjectId: projectId,
    api,
    cursor,
    onBatch: handleWorkspaceEventBatch,
    onReconcile: handleWorkspaceReconcile,
  })

  return {
    connectionState,
    lastSuccessfulSyncAt,
    projectRuns,
    retry: retryWorkspaceConnection,
    setProjectRuns,
    workspaceEventDiagnostic,
    workspaceEvents,
  }
}

export function mergeProjectRuns(
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
