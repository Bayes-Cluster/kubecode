import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { KubecodeApi, WorkspaceEvent } from './api'

const MAX_RETAINED_EVENTS = 2_048
const SESSION_EVENT_KINDS = new Set([
  'session_created', 'session_imported', 'session_updated', 'session_removed',
])
const TERMINAL_EVENT_KINDS = new Set([
  'terminal_created', 'terminal_updated', 'terminal_exited', 'terminal_closed',
])

export type WorkspaceConnectionState = 'connecting' | 'live' | 'reconnecting' | 'resynchronizing'

export type WorkspaceEventStreamDiagnostic = {
  code: 'invalid_json' | 'invalid_event'
  detail: string
}

export type WorkspaceEventOwnership = {
  connectionGeneration: number
  generation: number
  projectId: string | null
  isCurrent: () => boolean
}

export type WorkspaceEventReconciliationPlan = {
  cleanTerminalIds: string[]
  refreshGlobalSessions: boolean
  refreshProjectRuns: boolean
  refreshProjectSessions: boolean
  refreshTeams: boolean
  refreshTerminals: boolean
}

export type WorkspaceEventBatch = {
  events: WorkspaceEvent[]
  ownership: WorkspaceEventOwnership
  plan: WorkspaceEventReconciliationPlan
}

export type WorkspaceEventReconciliationRequest = {
  completeCleanTerminalIds: (terminalIds: string[]) => void
  dirtyPlanSinceStart: () => WorkspaceEventReconciliationPlan
  eventsSinceStart: () => WorkspaceEvent[]
  ownership: WorkspaceEventOwnership
  plan: WorkspaceEventReconciliationPlan
}

type WorkspaceEventStreamOptions = {
  activeProjectId: string | null
  api: KubecodeApi
  cursor: number | null
  onBatch: (batch: WorkspaceEventBatch) => void
  onReconcile?: (request: WorkspaceEventReconciliationRequest) => Promise<void>
}

export type WorkspaceEventStreamResult = {
  connectionLost: boolean
  connectionState: WorkspaceConnectionState
  diagnostic: WorkspaceEventStreamDiagnostic | null
  events: WorkspaceEvent[]
  lastSuccessfulSyncAt: number | null
  retry: () => void
}

export function useWorkspaceEventStream({
  activeProjectId,
  api,
  cursor,
  onBatch,
  onReconcile,
}: WorkspaceEventStreamOptions): WorkspaceEventStreamResult {
  const [connectionState, setConnectionStateValue] = useState<WorkspaceConnectionState>('connecting')
  const [diagnostic, setDiagnostic] = useState<WorkspaceEventStreamDiagnostic | null>(null)
  const [events, setEvents] = useState<WorkspaceEvent[]>([])
  const [lastSuccessfulSyncAt, setLastSuccessfulSyncAt] = useState<number | null>(null)
  const activeProjectIdRef = useRef(activeProjectId)
  const beginRecoveryRef = useRef<() => void>(() => undefined)
  const callbacksRef = useRef({ onBatch, onReconcile })
  const connectionGenerationRef = useRef(0)
  const connectionStateRef = useRef<WorkspaceConnectionState>('connecting')
  const dirtyPlanRef = useRef(emptyReconciliationPlan())
  const eventsRef = useRef<WorkspaceEvent[]>([])
  const generationRef = useRef(0)
  const highWaterRef = useRef(cursor ?? 0)
  const mountedRef = useRef(false)
  const recoveryAttemptRef = useRef(0)
  const recoveryNeededRef = useRef(false)
  const streamIdentityRef = useRef({ api, cursor })
  const transportHasOpenedRef = useRef(false)
  const transportOpenRef = useRef(false)

  const setConnectionState = useCallback((next: WorkspaceConnectionState) => {
    connectionStateRef.current = next
    setConnectionStateValue(next)
  }, [])

  const createOwnership = useCallback((): WorkspaceEventOwnership => {
    const connectionGeneration = connectionGenerationRef.current
    const generation = generationRef.current
    const projectId = activeProjectIdRef.current
    return {
      connectionGeneration,
      generation,
      projectId,
      isCurrent: () => mountedRef.current
        && connectionGenerationRef.current === connectionGeneration
        && generationRef.current === generation
        && activeProjectIdRef.current === projectId,
    }
  }, [])

  const createRequest = useCallback((
    plan: WorkspaceEventReconciliationPlan,
    ownership: WorkspaceEventOwnership,
    startId: number,
    recovery: boolean,
    completeCleanTerminalIds: (terminalIds: string[]) => void = () => undefined,
  ): WorkspaceEventReconciliationRequest => ({
    completeCleanTerminalIds,
    dirtyPlanSinceStart: () => recovery
      ? dirtyPlanRef.current
      : createDirtyReconciliationPlan(
          eventsRef.current.filter((event) => event.id > startId), ownership.projectId,
        ),
    eventsSinceStart: () => eventsRef.current.filter((event) => event.id > startId),
    ownership,
    plan,
  }), [])

  const beginRecovery = useCallback(() => {
    if (!mountedRef.current || !transportOpenRef.current || !recoveryNeededRef.current) return
    if (connectionStateRef.current === 'resynchronizing') return
    const attempt = ++recoveryAttemptRef.current
    const ownership = createOwnership()
    const startId = highWaterRef.current
    dirtyPlanRef.current = commandReconciliationPlan(dirtyPlanRef.current)
    setConnectionState('resynchronizing')

    const run = async () => {
      let attemptedPlan: WorkspaceEventReconciliationPlan | null = null
      const completedCleanTerminalIds = new Set<string>()
      try {
        await callbacksRef.current.onReconcile?.(createRequest(
          fullReconciliationPlan(), ownership, startId, true,
        ))
        while (ownership.isCurrent() && attempt === recoveryAttemptRef.current
          && hasReconciliationWork(dirtyPlanRef.current)) {
          const plan = dirtyPlanRef.current
          dirtyPlanRef.current = emptyReconciliationPlan()
          attemptedPlan = plan
          completedCleanTerminalIds.clear()
          await callbacksRef.current.onReconcile?.(createRequest(
            plan, ownership, highWaterRef.current, true, (terminalIds) => {
              for (const terminalId of terminalIds) completedCleanTerminalIds.add(terminalId)
              dirtyPlanRef.current = {
                ...dirtyPlanRef.current,
                cleanTerminalIds: dirtyPlanRef.current.cleanTerminalIds.filter(
                  (terminalId) => !completedCleanTerminalIds.has(terminalId),
                ),
              }
            },
          ))
          attemptedPlan = null
        }
        if (!ownership.isCurrent() || attempt !== recoveryAttemptRef.current) return
        recoveryNeededRef.current = false
        setLastSuccessfulSyncAt(Date.now())
        setConnectionState('live')
      } catch {
        const currentAttempt = ownership.isCurrent() && attempt === recoveryAttemptRef.current
        let retryPlan = emptyReconciliationPlan()
        if (attemptedPlan) {
          retryPlan = {
            ...attemptedPlan,
            cleanTerminalIds: attemptedPlan.cleanTerminalIds.filter(
              (terminalId) => !completedCleanTerminalIds.has(terminalId),
            ),
          }
          if (!currentAttempt) retryPlan = commandReconciliationPlan(retryPlan)
          dirtyPlanRef.current = mergeReconciliationPlans(
            retryPlan, dirtyPlanRef.current,
          )
        }
        if (!currentAttempt) {
          if (hasReconciliationWork(retryPlan)) {
            recoveryNeededRef.current = true
            if (transportOpenRef.current
              && connectionStateRef.current !== 'resynchronizing') {
              setConnectionState('reconnecting')
              queueMicrotask(() => beginRecoveryRef.current())
            }
          }
          return
        }
        recoveryNeededRef.current = true
        setConnectionState('reconnecting')
      }
    }
    void run()
  }, [createOwnership, createRequest, setConnectionState])

  useLayoutEffect(() => {
    beginRecoveryRef.current = beginRecovery
  }, [beginRecovery])

  const retry = useCallback(() => {
    if (!transportOpenRef.current || !recoveryNeededRef.current
      || connectionStateRef.current === 'resynchronizing') return
    connectionGenerationRef.current += 1
    beginRecovery()
  }, [beginRecovery])

  useLayoutEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      generationRef.current += 1
      connectionGenerationRef.current += 1
      recoveryAttemptRef.current += 1
    }
  }, [])

  useLayoutEffect(() => {
    callbacksRef.current = { onBatch, onReconcile }
    if (activeProjectIdRef.current !== activeProjectId) {
      activeProjectIdRef.current = activeProjectId
      generationRef.current += 1
    }
    if (streamIdentityRef.current.api !== api || streamIdentityRef.current.cursor !== cursor) {
      const replacementIdentity = { api, cursor }
      streamIdentityRef.current = replacementIdentity
      generationRef.current += 1
      connectionGenerationRef.current += 1
      recoveryAttemptRef.current += 1
      recoveryNeededRef.current = recoveryNeededRef.current
        || hasReconciliationWork(dirtyPlanRef.current)
      transportHasOpenedRef.current = false
      transportOpenRef.current = false
      connectionStateRef.current = 'connecting'
      eventsRef.current = []
      queueMicrotask(() => {
        if (!mountedRef.current
          || streamIdentityRef.current !== replacementIdentity) return
        setEvents([])
        setDiagnostic(null)
        setLastSuccessfulSyncAt(null)
        if (!transportHasOpenedRef.current) setConnectionState('connecting')
      })
    }
  }, [activeProjectId, api, cursor, onBatch, onReconcile, setConnectionState])

  useEffect(() => {
    if (!transportOpenRef.current || !recoveryNeededRef.current) return
    const timer = window.setTimeout(() => {
      if (connectionStateRef.current === 'resynchronizing') {
        recoveryAttemptRef.current += 1
        setConnectionState('reconnecting')
      }
      beginRecovery()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [activeProjectId, beginRecovery, setConnectionState])

  useEffect(() => {
    if (typeof EventSource === 'undefined' || cursor === null) return
    let closed = false
    let frame: number | null = null
    highWaterRef.current = cursor
    const pending = new Map<number, WorkspaceEvent>()
    const stream = new EventSource(api.workspaceEventStreamUrl(cursor))

    const flush = () => {
      frame = null
      if (closed) return
      const batchEvents = [...pending.values()]
        .filter((event) => event.id > highWaterRef.current)
        .sort((left, right) => left.id - right.id)
      pending.clear()
      if (batchEvents.length === 0) return
      highWaterRef.current = batchEvents.at(-1)?.id ?? highWaterRef.current
      const ownership = createOwnership()
      const plan = createReconciliationPlan(batchEvents, ownership.projectId)
      eventsRef.current = retainWorkspaceEvents(eventsRef.current, batchEvents)
      setEvents(eventsRef.current)
      callbacksRef.current.onBatch({ events: batchEvents, ownership, plan })
      if (connectionStateRef.current === 'resynchronizing') {
        dirtyPlanRef.current = mergeReconciliationPlans(
          dirtyPlanRef.current,
          createDirtyReconciliationPlan(batchEvents, ownership.projectId),
        )
      } else if (connectionStateRef.current !== 'reconnecting' && hasReconciliationWork(plan)) {
        const request = createRequest(plan, ownership, highWaterRef.current, false)
        void callbacksRef.current.onReconcile?.(request).catch(() => undefined)
      }
    }

    const receive = (message: MessageEvent<string>) => {
      if (closed) return
      let parsed: unknown
      try {
        parsed = JSON.parse(message.data)
      } catch {
        setDiagnostic({ code: 'invalid_json', detail: 'Workspace event JSON could not be parsed.' })
        return
      }
      const event = parseWorkspaceEvent(parsed)
      if (!event) {
        setDiagnostic({ code: 'invalid_event', detail: 'Workspace event failed schema validation.' })
        return
      }
      setDiagnostic(null)
      if (event.id <= highWaterRef.current) return
      pending.set(event.id, event)
      if (frame === null) frame = requestAnimationFrame(flush)
    }

    stream.addEventListener('workspace_event', receive as EventListener)
    stream.onopen = () => {
      if (closed) return
      transportOpenRef.current = true
      if (!transportHasOpenedRef.current && !recoveryNeededRef.current) {
        transportHasOpenedRef.current = true
        setConnectionState('live')
        return
      }
      transportHasOpenedRef.current = true
      if (!recoveryNeededRef.current || connectionStateRef.current === 'resynchronizing') return
      beginRecovery()
    }
    stream.onerror = () => {
      if (closed) return
      transportOpenRef.current = false
      recoveryNeededRef.current = true
      connectionGenerationRef.current += 1
      recoveryAttemptRef.current += 1
      setConnectionState('reconnecting')
    }
    return () => {
      closed = true
      transportOpenRef.current = false
      generationRef.current += 1
      connectionGenerationRef.current += 1
      recoveryAttemptRef.current += 1
      pending.clear()
      if (frame !== null) cancelAnimationFrame(frame)
      stream.close()
    }
  }, [api, beginRecovery, createOwnership, createRequest, cursor, setConnectionState])

  return {
    connectionLost: connectionState === 'reconnecting' || connectionState === 'resynchronizing',
    connectionState,
    diagnostic,
    events,
    lastSuccessfulSyncAt,
    retry,
  }
}

function parseWorkspaceEvent(value: unknown): WorkspaceEvent | null {
  if (!isRecord(value) || !Number.isSafeInteger(value.id) || typeof value.id !== 'number'
    || value.id <= 0 || !isNonEmptyString(value.kind) || !isNullableString(value.project_id)
    || !isNullableString(value.conversation_id) || !isNullableString(value.run_id)
    || !isRecord(value.payload) || !isNonEmptyString(value.created_at)) return null
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
  events: WorkspaceEvent[], activeProjectId: string | null,
): WorkspaceEventReconciliationPlan {
  const plan = emptyReconciliationPlan()
  for (const event of events) {
    if (SESSION_EVENT_KINDS.has(event.kind)) {
      plan.refreshGlobalSessions = true
      if (activeProjectId && event.project_id === activeProjectId) plan.refreshProjectSessions = true
    }
    if (activeProjectId && event.project_id === activeProjectId) {
      if (event.kind.startsWith('team_')) plan.refreshTeams = true
      if (TERMINAL_EVENT_KINDS.has(event.kind)) plan.refreshTerminals = true
    }
    if (isCleanTerminalExit(event) && typeof event.payload.terminal_id === 'string') {
      plan.cleanTerminalIds.push(event.payload.terminal_id)
    }
  }
  plan.cleanTerminalIds = [...new Set(plan.cleanTerminalIds)]
  return plan
}

function createDirtyReconciliationPlan(
  events: WorkspaceEvent[], activeProjectId: string | null,
): WorkspaceEventReconciliationPlan {
  const plan = createReconciliationPlan(events, activeProjectId)
  if (activeProjectId && events.some((event) => (
    event.project_id === activeProjectId && isRunProjectionEvent(event.kind)
  ))) plan.refreshProjectRuns = true
  return plan
}

function isRunProjectionEvent(kind: string): boolean {
  return kind === 'run_started' || kind === 'run_completed'
    || kind === 'permission_requested' || kind === 'permission_resolved'
    || kind === 'elicitation_requested' || kind === 'elicitation_resolved'
}

function emptyReconciliationPlan(): WorkspaceEventReconciliationPlan {
  return {
    cleanTerminalIds: [],
    refreshGlobalSessions: false,
    refreshProjectRuns: false,
    refreshProjectSessions: false,
    refreshTeams: false,
    refreshTerminals: false,
  }
}

function fullReconciliationPlan(): WorkspaceEventReconciliationPlan {
  return {
    cleanTerminalIds: [],
    refreshGlobalSessions: true,
    refreshProjectRuns: true,
    refreshProjectSessions: true,
    refreshTeams: true,
    refreshTerminals: true,
  }
}

function commandReconciliationPlan(
  plan: WorkspaceEventReconciliationPlan,
): WorkspaceEventReconciliationPlan {
  return {
    ...emptyReconciliationPlan(),
    cleanTerminalIds: plan.cleanTerminalIds,
  }
}

function mergeReconciliationPlans(
  left: WorkspaceEventReconciliationPlan,
  right: WorkspaceEventReconciliationPlan,
): WorkspaceEventReconciliationPlan {
  return {
    cleanTerminalIds: [...new Set([...left.cleanTerminalIds, ...right.cleanTerminalIds])],
    refreshGlobalSessions: left.refreshGlobalSessions || right.refreshGlobalSessions,
    refreshProjectRuns: left.refreshProjectRuns || right.refreshProjectRuns,
    refreshProjectSessions: left.refreshProjectSessions || right.refreshProjectSessions,
    refreshTeams: left.refreshTeams || right.refreshTeams,
    refreshTerminals: left.refreshTerminals || right.refreshTerminals,
  }
}

function hasReconciliationWork(plan: WorkspaceEventReconciliationPlan): boolean {
  return plan.cleanTerminalIds.length > 0
    || plan.refreshGlobalSessions || plan.refreshProjectRuns || plan.refreshProjectSessions
    || plan.refreshTeams || plan.refreshTerminals
}

function retainWorkspaceEvents(current: WorkspaceEvent[], batch: WorkspaceEvent[]): WorkspaceEvent[] {
  const byId = new Map(current.map((event) => [event.id, event]))
  for (const event of batch) byId.set(event.id, event)
  return [...byId.values()].sort((left, right) => left.id - right.id).slice(-MAX_RETAINED_EVENTS)
}

function isCleanTerminalExit(event: WorkspaceEvent): boolean {
  return event.kind === 'terminal_exited' && event.payload.exit_code === 0 && event.payload.signal === null
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
