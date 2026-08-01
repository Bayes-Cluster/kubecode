import { useEffect } from 'react'

import type { AgentEvent, Conversation, KubecodeApi, WorkspaceEvent } from '../api'
import {
  applyAgentEvent,
  applySideQuestionEvent,
  elicitationFromEvent,
  initialElicitationAnswers,
  permissionFromEvent,
  SESSION_STATE_EVENT_KINDS,
  SIDE_QUESTION_EVENT_KINDS,
} from './sessionModel'
import type { SessionTranscript } from './useSessionHistory'

type UseSessionEventsOptions = {
  api: KubecodeApi
  conversation: Conversation | null
  reportError: (cause: unknown) => void
  requestSessionState: (targetConversationId: string) => Promise<void>
  transcript: SessionTranscript
  viewRevisionId: string | null
  workspaceEvents: WorkspaceEvent[]
}

export function useSessionEvents({
  api,
  conversation,
  reportError,
  requestSessionState,
  transcript,
  viewRevisionId,
  workspaceEvents,
}: UseSessionEventsOptions) {
  const {
    attachRun,
    knownRunIdsRef,
    latestWorkspaceEventIdRef,
    loadRun,
    pendingRunEventsRef,
    processedWorkspaceEventRef,
    setElicitationAnswers,
    setMessages,
    setPendingElicitation,
    setPendingPermission,
    setSideQuestions,
  } = transcript
  latestWorkspaceEventIdRef.current = workspaceEvents.at(-1)?.id ?? 0

  useEffect(() => {
    if (!conversation || viewRevisionId) return
    const nextEvents = workspaceEvents.filter((event) => (
      event.id > processedWorkspaceEventRef.current
        && event.conversation_id === conversation.id
    ))
    processedWorkspaceEventRef.current = workspaceEvents.at(-1)?.id
      ?? processedWorkspaceEventRef.current
    let refreshState = false
    for (const workspaceEvent of nextEvents) {
      refreshState ||= SESSION_STATE_EVENT_KINDS.has(workspaceEvent.kind)
      if (!workspaceEvent.run_id) continue
      const event: AgentEvent = {
        created_at: workspaceEvent.created_at,
        kind: workspaceEvent.kind,
        payload: workspaceEvent.payload,
        run_id: workspaceEvent.run_id as string,
        seq: workspaceEvent.id,
      }
      if (SIDE_QUESTION_EVENT_KINDS.has(event.kind)) {
        setSideQuestions((current) => applySideQuestionEvent(current, event.kind, event.payload))
        continue
      }
      if (event.kind === 'permission_requested') {
        const permission = permissionFromEvent(event)
        if (permission) setPendingPermission(permission)
      }
      if (event.kind === 'permission_resolved') setPendingPermission(null)
      if (event.kind === 'elicitation_requested') {
        const elicitation = elicitationFromEvent(event)
        if (elicitation) {
          setPendingElicitation(elicitation)
          setElicitationAnswers(initialElicitationAnswers(elicitation))
        }
      }
      if (event.kind === 'elicitation_resolved') setPendingElicitation(null)
      if (event.kind === 'run_started') {
        void loadRun(event.run_id)
      } else if (knownRunIdsRef.current.has(event.run_id)) {
        setMessages((current) => applyAgentEvent(current, event.run_id, event))
      } else {
        const pending = pendingRunEventsRef.current.get(event.run_id) ?? []
        pendingRunEventsRef.current.set(event.run_id, [...pending, event])
        void loadRun(event.run_id)
      }
      if (event.kind === 'run_completed') {
        void api.getRun(event.run_id).then(attachRun)
      }
    }
    if (refreshState) {
      const conversationId = conversation.id
      void requestSessionState(conversationId).catch(reportError)
    }
  }, [
    api,
    attachRun,
    conversation,
    knownRunIdsRef,
    loadRun,
    pendingRunEventsRef,
    processedWorkspaceEventRef,
    reportError,
    requestSessionState,
    setElicitationAnswers,
    setMessages,
    setPendingElicitation,
    setPendingPermission,
    setSideQuestions,
    viewRevisionId,
    workspaceEvents,
  ])
}
