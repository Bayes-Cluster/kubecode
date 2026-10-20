import { useEffect, useRef, useState } from 'react'

import type { AttentionSummary, KubecodeApi, WorkspaceEvent } from '../api'
import { useRefreshTick } from '../research/useResearch'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'

/** The changes that can add or remove a decision: as the Workspace store's, General and research included. */
const KINDS = new Set([
  'task_updated',
  'research_updated',
  'channel_updated',
  'work_updated',
  'member_updated',
  'orchestration_updated',
  'permission_requested',
  'permission_resolved',
  'elicitation_requested',
  'elicitation_resolved',
  'team_permission_updated',
  'run_started',
  'run_completed',
])
const DEBOUNCE_MS = 1_000
const matches = (event: WorkspaceEvent) => (
  KINDS.has(event.kind) || (event.kind === 'conversation_state' && Object.hasOwn(event.payload, 'pending'))
)

/**
 * How much waits on the researcher in every Workspace (ADR 0232), for the
 * title bar's bell: read on mount, after changes anywhere (gathered for a
 * second) and after a reconnect; an older answer never replaces a newer one.
 */
export function useAttentionSummary(
  api: KubecodeApi,
  events: WorkspaceEvent[],
  connectionState: WorkspaceConnectionState,
): AttentionSummary | null {
  const [summary, setSummary] = useState<AttentionSummary | null>(null)
  const tick = useRefreshTick(events, connectionState, matches)
  const ticket = useRef(0)
  const applied = useRef({ ticket: 0, cursor: -1 })
  const first = useRef(true)
  useEffect(() => {
    if (typeof api.attentionSummary !== 'function') return
    const read = () => {
      const mine = ++ticket.current
      api.attentionSummary().then((next) => {
        if (mine < applied.current.ticket || next.cursor < applied.current.cursor) return
        applied.current = { ticket: mine, cursor: next.cursor }
        setSummary(next)
      }).catch(() => undefined)
    }
    if (first.current) {
      first.current = false
      read()
      return
    }
    const timer = window.setTimeout(read, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [api, tick])
  return summary
}
