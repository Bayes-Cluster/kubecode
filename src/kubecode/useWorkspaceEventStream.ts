import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { KubecodeApi, WorkspaceEvent } from './api'

const MAX_RETAINED_EVENTS = 2_048
const SESSION_EVENT_KINDS = new Set([
  'session_created',
  'session_imported',
  'session_updated',
  'session_removed',
])
const TERMINAL_EVENT_KINDS = new Set([
  'terminal_created',
  'terminal_updated',
  'terminal_exited',
  'terminal_closed',
])

export type WorkspaceEventStreamDiagnostic = {
  code: 'invalid_json' | 'invalid_event'
  detail: string
}

export type WorkspaceEventOwnership = {
  generation: number
  projectId: string | null
  isCurrent: () => boolean
}

export type WorkspaceEventReconciliationPlan = {
  cleanTerminalIds: string[]
  refreshGlobalSessions: boolean
  refreshProjectSessions: boolean
  refreshTeams: boolean
  refreshTerminals: boolean
}

export type WorkspaceEventBatch = {
  events: WorkspaceEvent[]
  ownership: WorkspaceEventOwnership
  plan: WorkspaceEventReconciliationPlan
}

type WorkspaceEventStreamOptions = {
  activeProjectId: string | null
  api: KubecodeApi
  cursor: number | null
  onBatch: (batch: WorkspaceEventBatch) => void
  onOpen?: (ownership: WorkspaceEventOwnership) => void
}

type WorkspaceEventStreamResult = {
  connectionLost: boolean
  diagnostic: WorkspaceEventStreamDiagnostic | null
  events: WorkspaceEvent[]
}

export function useWorkspaceEventStream({
  activeProjectId,
  api,
  cursor,
  onBatch,
  onOpen,
}: WorkspaceEventStreamOptions): WorkspaceEventStreamResult {
  const [connectionLost, setConnectionLost] = useState(false)
  const [diagnostic, setDiagnostic] = useState<WorkspaceEventStreamDiagnostic | null>(null)
  const [events, setEvents] = useState<WorkspaceEvent[]>([])
  const activeProjectIdRef = useRef(activeProjectId)
  const callbacksRef = useRef({ onBatch, onOpen })
  const generationRef = useRef(0)
  const mountedRef = useRef(false)
  const streamIdentityRef = useRef({ api, cursor })

  useLayoutEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      generationRef.current += 1
    }
  }, [])

  useLayoutEffect(() => {
    callbacksRef.current = { onBatch, onOpen }
    if (activeProjectIdRef.current !== activeProjectId) {
      activeProjectIdRef.current = activeProjectId
      generationRef.current += 1
    }
    if (streamIdentityRef.current.api !== api || streamIdentityRef.current.cursor !== cursor) {
      streamIdentityRef.current = { api, cursor }
      generationRef.current += 1
    }
  }, [activeProjectId, api, cursor, onBatch, onOpen])

  useEffect(() => {
    if (typeof EventSource === 'undefined' || cursor === null) return
    let closed = false
    let frame: number | null = null
    let highWater = cursor
    const pending = new Map<number, WorkspaceEvent>()
    const stream = new EventSource(api.workspaceEventStreamUrl(cursor))

    const ownership = (): WorkspaceEventOwnership => {
      const generation = generationRef.current
      const projectId = activeProjectIdRef.current
      return {
        generation,
        projectId,
        isCurrent: () => mountedRef.current
          && generationRef.current === generation
          && activeProjectIdRef.current === projectId,
      }
    }

    const flush = () => {
      frame = null
      if (closed) return
      const batchEvents = [...pending.values()]
        .filter((event) => event.id > highWater)
        .sort((left, right) => left.id - right.id)
      pending.clear()
      if (batchEvents.length === 0) return
      highWater = batchEvents.at(-1)?.id ?? highWater
      const batchOwnership = ownership()
      setEvents((current) => retainWorkspaceEvents(current, batchEvents))
      callbacksRef.current.onBatch({
        events: batchEvents,
        ownership: batchOwnership,
        plan: createReconciliationPlan(batchEvents, batchOwnership.projectId),
      })
    }

    const receive = (message: MessageEvent<string>) => {
      if (closed) return
      let parsed: unknown
      try {
        parsed = JSON.parse(message.data)
      } catch {
        setDiagnostic({
          code: 'invalid_json',
          detail: 'Workspace event JSON could not be parsed.',
        })
        return
      }
      const event = parseWorkspaceEvent(parsed)
      if (!event) {
        setDiagnostic({
          code: 'invalid_event',
          detail: 'Workspace event failed schema validation.',
        })
        return
      }
      setDiagnostic(null)
      if (event.id <= highWater) return
      pending.set(event.id, event)
      if (frame === null) frame = requestAnimationFrame(flush)
    }

    stream.addEventListener('workspace_event', receive as EventListener)
    stream.onopen = () => {
      if (closed) return
      setConnectionLost(false)
      callbacksRef.current.onOpen?.(ownership())
    }
    stream.onerror = () => {
      if (!closed) setConnectionLost(true)
    }
    return () => {
      closed = true
      generationRef.current += 1
      pending.clear()
      if (frame !== null) cancelAnimationFrame(frame)
      stream.close()
    }
  }, [api, cursor])

  return { connectionLost, diagnostic, events }
}

function parseWorkspaceEvent(value: unknown): WorkspaceEvent | null {
  if (!isRecord(value)
    || !Number.isSafeInteger(value.id)
    || typeof value.id !== 'number'
    || value.id <= 0
    || !isNonEmptyString(value.kind)
    || !isNullableString(value.project_id)
    || !isNullableString(value.conversation_id)
    || !isNullableString(value.run_id)
    || !isRecord(value.payload)
    || !isNonEmptyString(value.created_at)) {
    return null
  }
  return {
    id: value.id,
    kind: value.kind,
    project_id: value.project_id,
    conversation_id: value.conversation_id,
    run_id: value.run_id,
    payload: value.payload,
    created_at: value.created_at,
  }
}

function createReconciliationPlan(
  events: WorkspaceEvent[],
  activeProjectId: string | null,
): WorkspaceEventReconciliationPlan {
  const cleanTerminalIds = new Set<string>()
  let refreshGlobalSessions = false
  let refreshProjectSessions = false
  let refreshTeams = false
  let refreshTerminals = false
  for (const event of events) {
    if (SESSION_EVENT_KINDS.has(event.kind)) {
      refreshGlobalSessions = true
      if (activeProjectId && event.project_id === activeProjectId) refreshProjectSessions = true
    }
    if (activeProjectId && event.project_id === activeProjectId) {
      if (event.kind.startsWith('team_')) refreshTeams = true
      if (TERMINAL_EVENT_KINDS.has(event.kind)) refreshTerminals = true
    }
    if (isCleanTerminalExit(event) && typeof event.payload.terminal_id === 'string') {
      cleanTerminalIds.add(event.payload.terminal_id)
    }
  }
  return {
    cleanTerminalIds: [...cleanTerminalIds],
    refreshGlobalSessions,
    refreshProjectSessions,
    refreshTeams,
    refreshTerminals,
  }
}

function retainWorkspaceEvents(
  current: WorkspaceEvent[],
  batch: WorkspaceEvent[],
): WorkspaceEvent[] {
  const byId = new Map(current.map((event) => [event.id, event]))
  for (const event of batch) byId.set(event.id, event)
  return [...byId.values()]
    .sort((left, right) => left.id - right.id)
    .slice(-MAX_RETAINED_EVENTS)
}

function isCleanTerminalExit(event: WorkspaceEvent): boolean {
  return event.kind === 'terminal_exited'
    && event.payload.exit_code === 0
    && event.payload.signal === null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}
