import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ApiError, type ChannelMessage, type KubecodeApi, type MessageDelivery, type WorkspaceEvent } from '../api'
import { useRefreshTick } from '../research/useResearch'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'
import type { DeliveryActions, DeliveryRefusal } from './deliveryContext'

/** The researcher's own top-level messages: the only ones whose delivery is projected. */
function tracked(message: ChannelMessage): boolean {
  return message.author_kind === 'researcher' && message.thread_id === null
}

function refusalOf(cause: unknown): DeliveryRefusal {
  if (cause instanceof ApiError) {
    if (cause.code === 'route_target_gone') return 'gone'
    if (cause.code === 'retry_limit') return 'limit'
    if (cause.code === 'route_not_retryable' || cause.code === 'message_not_reroutable') return 'notRetryable'
  }
  return 'failed'
}

/**
 * Routing notes about a loaded message's delivery are folded into it (ADR
 * 0232): they leave the timeline and are kept, by message, for its Details.
 * A note about anything not on the page stays where it is.
 */
export function foldRoutingNotes(
  messages: readonly ChannelMessage[],
  deliveries: ReadonlyMap<string, MessageDelivery>,
): { messages: ChannelMessage[]; folded: Map<string, string[]> } {
  const owner = new Map<string, string>()
  for (const delivery of deliveries.values()) {
    for (const route of delivery.routes) route.note_ids.forEach((id) => owner.set(id, delivery.message_id))
    if (delivery.denial?.note_id) owner.set(delivery.denial.note_id, delivery.message_id)
  }
  const folded = new Map<string, string[]>()
  const kept = messages.filter((message) => {
    const to = message.author_kind === 'system' ? owner.get(message.id) : undefined
    if (!to) return true
    folded.set(to, [...(folded.get(to) ?? []), message.body])
    return false
  })
  return { messages: kept, folded }
}

/**
 * The delivery of the researcher's messages on screen, read from the server
 * and refreshed when a route of one of them changes, while one is still on
 * its way, and after a reconnect; with Retry and Try again, each at most once
 * in flight.
 */
export function useMessageDeliveries(
  api: KubecodeApi,
  projectId: string,
  channelId: string | null,
  messages: readonly ChannelMessage[],
  events: WorkspaceEvent[],
  connectionState: WorkspaceConnectionState,
): { deliveries: ReadonlyMap<string, MessageDelivery>; actions: Omit<DeliveryActions, 'openMembers' | 'copyToComposer'> } {
  const ids = useMemo(() => messages.filter(tracked).map((message) => message.id), [messages])
  const key = ids.join(',')
  const [deliveries, setDeliveries] = useState<ReadonlyMap<string, MessageDelivery>>(new Map())
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [refusals, setRefusals] = useState<ReadonlyMap<string, DeliveryRefusal>>(new Map())
  const moving = [...deliveries.values()].some((delivery) => delivery.state === 'saved' || delivery.state === 'sending')
  const matches = useCallback((event: WorkspaceEvent) => {
    if (event.project_id !== projectId) return false
    if (event.kind === 'orchestration_updated') {
      const id = event.payload.message_id
      return typeof id === 'string' && key.split(',').includes(id)
    }
    return event.kind === 'channel_updated' && moving
  }, [key, moving, projectId])
  const tick = useRefreshTick(events, connectionState, matches)
  const [manual, setManual] = useState(0)
  const ticket = useRef(0)

  const merge = useCallback((list: MessageDelivery[]) => {
    if (list.length === 0) return
    setDeliveries((current) => {
      const next = new Map(current)
      list.forEach((delivery) => next.set(delivery.message_id, delivery))
      return next
    })
  }, [])

  useEffect(() => {
    if (!key || typeof api.messageDeliveries !== 'function') return
    const mine = ++ticket.current
    api.messageDeliveries(projectId, key.split(',')).then((list) => {
      if (mine === ticket.current) merge(list)
    }).catch(() => undefined)
  }, [api, key, merge, projectId, tick, manual])

  const mark = (id: string, on: boolean) => setBusy((current) => {
    const next = new Set(current)
    if (on) next.add(id)
    else next.delete(id)
    return next
  })
  const refuse = (id: string, refusal: DeliveryRefusal | null) => setRefusals((current) => {
    const next = new Map(current)
    if (refusal) next.set(id, refusal)
    else next.delete(id)
    return next
  })
  const inFlight = useRef(new Set<string>())
  const once = (id: string, call: () => Promise<void>) => {
    if (inFlight.current.has(id)) return Promise.resolve()
    inFlight.current.add(id)
    mark(id, true)
    refuse(id, null)
    return call().catch((cause) => refuse(id, refusalOf(cause))).finally(() => {
      inFlight.current.delete(id)
      mark(id, false)
      setManual((value) => value + 1)
    })
  }

  return {
    deliveries,
    actions: {
      busy,
      refusals,
      retry: (routeId) => {
        void once(routeId, async () => {
          const result = await api.retryRoute(projectId, routeId)
          if (result.delivery) merge([result.delivery])
        })
      },
      reroute: (messageId) => {
        if (!channelId) return
        void once(messageId, async () => {
          merge([await api.rerouteMessage(projectId, channelId, messageId)])
        })
      },
    },
  }
}
