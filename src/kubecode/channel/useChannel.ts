import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  Channel,
  ChannelMessage,
  ChannelThread,
  KubecodeApi,
  WorkspaceEvent,
} from '../api'
import { useRefreshTick } from '../research/useResearch'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'

export type ChannelLoadStatus = 'loading' | 'ready' | 'error'

const PAGE = 50
const MAX_CATCH_UP_PAGES = 20

function mergeMessages(current: ChannelMessage[], incoming: ChannelMessage[]): ChannelMessage[] {
  const bySeq = new Map(current.map((message) => [message.seq, message]))
  for (const message of incoming) bySeq.set(message.seq, message)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

/** The Project's default channel (created by the server on first use). */
export function useDefaultChannel(api: KubecodeApi, projectId: string | null) {
  const [loaded, setLoaded] = useState<{ projectId: string; channel: Channel } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!projectId || typeof api.listChannels !== 'function') return
    let cancelled = false
    api.listChannels(projectId).then((channels) => {
      if (cancelled) return
      const channel = channels.find((item) => item.is_default) ?? channels[0]
      if (channel) setLoaded({ projectId, channel })
      setFailed(channel ? null : projectId)
    }).catch(() => {
      if (!cancelled) setFailed(projectId)
    })
    return () => { cancelled = true }
  }, [api, projectId, attempt])

  const current = loaded && loaded.projectId === projectId ? loaded.channel : null
  const status: ChannelLoadStatus = current ? 'ready' : failed === projectId ? 'error' : 'loading'
  return { channel: current, status, retry: useCallback(() => setAttempt((value) => value + 1), []) }
}

export type MessageFeed = {
  messages: ChannelMessage[]
  /** Older messages exist than the first one loaded. */
  hasMore: boolean
  status: ChannelLoadStatus
  loadingOlder: boolean
  loadOlder: () => void
  /** Shows a message the caller just saved without waiting for the event. */
  append: (message: ChannelMessage) => void
  reload: () => void
}

/**
 * A channel's top-level timeline, or one Thread's messages. Loads the latest
 * page, scrolls back on request, and converges on `channel_updated` events and
 * stream reconnects by reading everything newer than what it has. Messages are
 * immutable, so merging by sequence number is safe and never duplicates.
 */
export function useMessageFeed(
  api: KubecodeApi,
  projectId: string | null,
  channelId: string | null,
  threadId: string | null,
  events: WorkspaceEvent[],
  connectionState: WorkspaceConnectionState,
  taskId: string | null = null,
): MessageFeed {
  const scope = projectId && channelId ? `${projectId}/${channelId}/${threadId ?? ''}/${taskId ?? ''}` : null
  const [state, setState] = useState<{
    scope: string
    messages: ChannelMessage[]
    hasMore: boolean
  } | null>(null)
  const [failedScope, setFailedScope] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [manual, setManual] = useState(0)
  const matches = useCallback((event: WorkspaceEvent) => (
    event.kind === 'channel_updated'
    && event.project_id === projectId
    && event.payload.channel_id === channelId
    && (threadId === null || event.payload.thread_id === threadId || event.payload.thread_id == null)
  ), [projectId, channelId, threadId])
  const tick = useRefreshTick(events, connectionState, matches)
  const ticket = useRef(0)
  const stateRef = useRef(state)
  useEffect(() => { stateRef.current = state }, [state])

  useEffect(() => {
    if (!scope || !projectId || !channelId || typeof api.listChannelMessages !== 'function') return
    const mine = ++ticket.current
    const known = stateRef.current?.scope === scope ? stateRef.current : null
    const run = async () => {
      if (!known || known.messages.length === 0) {
        const page = await api.listChannelMessages(projectId, channelId, { threadId, taskId, limit: PAGE })
        return { messages: page.messages, hasMore: page.has_more, initial: true }
      }
      let messages = known.messages
      let after = messages[messages.length - 1].seq
      for (let pages = 0; pages < MAX_CATCH_UP_PAGES; pages += 1) {
        const page = await api.listChannelMessages(projectId, channelId, {
          threadId, taskId, afterSeq: after, limit: PAGE,
        })
        if (page.messages.length === 0) break
        messages = mergeMessages(messages, page.messages)
        after = page.messages[page.messages.length - 1].seq
        if (page.messages.length < PAGE) break
      }
      return { messages, hasMore: known.hasMore, initial: false }
    }
    run().then((next) => {
      if (mine !== ticket.current) return
      setState((current) => {
        // Keep anything a local append or an older page already added.
        const base = current?.scope === scope ? current : null
        return {
          scope,
          messages: mergeMessages(base?.messages ?? [], next.messages),
          hasMore: base && base.messages.length > 0 && !next.initial ? base.hasMore : next.hasMore,
        }
      })
      setFailedScope(null)
    }).catch(() => {
      if (mine === ticket.current) setFailedScope(scope)
    })
  }, [api, projectId, channelId, threadId, taskId, scope, tick, manual])

  const current = state && state.scope === scope ? state : null

  const loadOlder = useCallback(() => {
    const held = stateRef.current
    if (!projectId || !channelId || !held || held.scope !== scope || !held.hasMore || loadingOlder) return
    const first = held.messages[0]
    if (!first) return
    setLoadingOlder(true)
    api.listChannelMessages(projectId, channelId, { threadId, taskId, beforeSeq: first.seq, limit: PAGE })
      .then((page) => {
        setState((now) => (
          now && now.scope === scope
            ? { scope, messages: mergeMessages(now.messages, page.messages), hasMore: page.has_more }
            : now
        ))
      })
      .catch(() => setFailedScope(scope))
      .finally(() => setLoadingOlder(false))
  }, [api, projectId, channelId, threadId, taskId, scope, loadingOlder])

  const append = useCallback((message: ChannelMessage) => {
    // A message that is not about the filtered Task belongs to the unfiltered view only.
    if (taskId && message.task_id !== taskId) return
    setState((now) => (
      now && now.scope === scope
        ? { ...now, messages: mergeMessages(now.messages, [message]) }
        : now
    ))
  }, [scope, taskId])

  const unsupported = typeof api.listChannelMessages !== 'function'
  const status: ChannelLoadStatus = current || unsupported
    ? 'ready'
    : failedScope === scope ? 'error' : 'loading'
  return {
    messages: current?.messages ?? [],
    hasMore: current?.hasMore ?? false,
    status,
    loadingOlder,
    loadOlder,
    append,
    reload: useCallback(() => setManual((value) => value + 1), []),
  }
}

/** A channel's Threads, converged on `channel_updated` events. */
export function useChannelThreads(
  api: KubecodeApi,
  projectId: string | null,
  channelId: string | null,
  events: WorkspaceEvent[],
  connectionState: WorkspaceConnectionState,
) {
  const key = projectId && channelId ? `${projectId}/${channelId}` : null
  const [loaded, setLoaded] = useState<{ key: string; threads: ChannelThread[] } | null>(null)
  const [manual, setManual] = useState(0)
  const matches = useCallback((event: WorkspaceEvent) => (
    event.kind === 'channel_updated'
    && event.project_id === projectId
    && event.payload.channel_id === channelId
  ), [projectId, channelId])
  const tick = useRefreshTick(events, connectionState, matches)
  const ticket = useRef(0)

  useEffect(() => {
    if (!key || !projectId || !channelId || typeof api.listChannelThreads !== 'function') return
    const mine = ++ticket.current
    api.listChannelThreads(projectId, channelId).then((threads) => {
      if (mine === ticket.current) setLoaded({ key, threads })
    }).catch(() => undefined)
  }, [api, projectId, channelId, key, tick, manual])

  const threads = useMemo(
    () => (loaded && loaded.key === key ? loaded.threads : []),
    [loaded, key],
  )
  return { threads, reload: useCallback(() => setManual((value) => value + 1), []) }
}
