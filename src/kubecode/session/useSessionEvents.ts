import { useEffect, useRef } from 'react'

import type { Conversation, WorkspaceEvent } from '../api'
import { arrayValue, objectValue, textValue } from './conversationReducer'
import type { TimelineEvent } from './conversationReducer'
import { SESSION_STATE_EVENT_KINDS } from './sessionModel'
import type { SessionTranscript } from './useSessionHistory'

type UseSessionEventsOptions = {
  applySessionStatePayload: (targetConversationId: string, kind: string, payload: unknown) => void
  conversation: Conversation | null
  reportError: (cause: unknown) => void
  requestSessionState: (targetConversationId: string) => Promise<void>
  transcript: SessionTranscript
  viewRevisionId: string | null
  workspaceEvents: WorkspaceEvent[]
}

/**
 * Live ingestion (#103): every workspace event becomes a TimelineEvent and
 * enters the single frame-budgeted queue feeding the shared reducer.
 * Terminal convergence needs no refetch — `run_completed` already carries
 * its typed cause (#92); #93 surfaces it.
 */
export function useSessionEvents({
  applySessionStatePayload,
  conversation,
  reportError,
  requestSessionState,
  transcript,
  viewRevisionId,
  workspaceEvents,
}: UseSessionEventsOptions) {
  const { enqueueConversationEvents } = transcript
  const processedRef = useRef<number>(0)
  const initializedForRef = useRef<string | null>(null)
  const reportErrorRef = useRef(reportError)
  reportErrorRef.current = reportError

  useEffect(() => {
    if (!conversation || viewRevisionId) return

    const latestId = workspaceEvents.at(-1)?.id ?? 0
    // First sight of a conversation swallows the pre-mount backlog: recorded
    // history replays those through the same reducer during hydration.
    if (initializedForRef.current !== conversation.id) {
      initializedForRef.current = conversation.id
      processedRef.current = latestId
      return
    }

    const batch: TimelineEvent[] = []
    let needsFullStateRefresh = false
    for (const workspaceEvent of workspaceEvents) {
      if (workspaceEvent.id <= processedRef.current) continue
      processedRef.current = workspaceEvent.id
      if (workspaceEvent.conversation_id
        && workspaceEvent.conversation_id !== conversation.id) continue

      // Session-state checkpoints name the kinds they carry (#106): locally
      // routable ones apply directly with no refetch; anything else keeps the
      // legacy full-state refresh.
      if (workspaceEvent.kind === 'session_state') {
        const updates = arrayValue(objectValue(workspaceEvent.payload)?.updates)
        if (updates) {
          const kinds = updates.map((entry) => textValue(objectValue(entry)?.kind))
          for (const kind of kinds) {
            if (kind === 'usage' || kind === 'current_mode') {
              applySessionStatePayload(conversation.id, kind, objectValue(
                updates.map((entry) => objectValue(entry)).find((entry) => textValue(entry?.kind) === kind)?.payload,
              ))
            }
          }
          if (kinds.some((kind) => kind !== 'usage' && kind !== 'current_mode')) {
            needsFullStateRefresh = true
          }
        } else {
          needsFullStateRefresh = true
        }
      } else {
        needsFullStateRefresh ||= SESSION_STATE_EVENT_KINDS.has(workspaceEvent.kind)
      }

      batch.push({
        seq: workspaceEvent.id,
        kind: workspaceEvent.kind,
        payload: workspaceEvent.payload,
        runId: typeof workspaceEvent.run_id === 'string' ? workspaceEvent.run_id : null,
        source: 'live',
      })
    }
    if (batch.length > 0) enqueueConversationEvents(batch)
    if (needsFullStateRefresh && !viewRevisionId) {
      void requestSessionState(conversation.id).catch((cause: unknown) => {
        reportErrorRef.current(cause)
      })
    }
  }, [
    applySessionStatePayload,
    conversation,
    enqueueConversationEvents,
    requestSessionState,
    viewRevisionId,
    workspaceEvents,
  ])
}
