import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import type { Translator } from '@/lib/i18n'

import type {
  ChannelMessage,
  Conversation,
  KubecodeApi,
  NewChannelMessage,
  ProjectContextRef,
  ResearchSummary,
  WorkspaceEvent,
} from '../api'
import { placeKey, usePlaceState, type Landing, type ReadingPosition } from '../app/location/placeMemory'
import { useAction } from '../research/useAction'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'
import { MessageComposer } from './MessageComposer'
import { useMentionOptions } from './useMentionOptions'
import { MessageList } from './MessageList'
import { authorName } from './channelLabels'
import { ThreadPane } from './ThreadPane'
import { useChannelThreads, useDefaultChannel, useMessageFeed } from './useChannel'

export type ChannelWorkspaceProps = {
  api: KubecodeApi
  connectionState: WorkspaceConnectionState
  /** Sessions of every Project; filtered to this one here. */
  conversations: Conversation[]
  events: WorkspaceEvent[]
  /** A Thread to open on arrival (for example from a research question). */
  initialThreadId?: string | null
  /**
   * The inspector, beside the conversation or over it (ADR 0228 §3). Over it,
   * the conversation stays mounted underneath; the inspector has the way back.
   */
  detail?: ReactNode
  /** The detail covers the conversation (a phone): it is parked, inert, under it. */
  detailCovers?: boolean
  /** A message to land on, and to return to when the detail closes. */
  focusMessageId?: string | null
  /**
   * How `focusMessageId` is arrived at: `focus` (a link, a closed detail)
   * focuses the message, `quiet` only scrolls to it, `composer` focuses the
   * composer. Transient; never part of the address.
   */
  landing?: Landing
  /** Where the researcher is reading and what had focus, as it changes (ADR 0228 §4). */
  onReadingPositionChange?: (position: ReadingPosition) => void
  /** Show only the messages about this Task (controlled by the route). */
  filter?: string | null
  onFilterChange?: (taskId: string | null) => void
  /** Reports the open Thread so the route can name it. */
  onThreadChange?: (threadId: string | null) => void
  /** Opens a Task from a message's chip, in the detail pane. */
  onOpenTask?: (taskId: string, messageId: string) => void
  /** Task ids that are on the board, to mark proposals that are not. */
  tasksOnBoard?: ReadonlySet<string>
  /**
   * Opens a reference chip where references open everywhere (ADR 0228 §3):
   * the shell's navigation. Without it, Tasks, Sessions, and Threads still open.
   */
  onOpenReference?: (reference: ProjectContextRef) => void
  onOpenResearch: (researchId: string) => void
  onOpenSession: (conversationId: string) => void
  /** Opens the one work board filtered to what came from a Thread. */
  onOpenWork?: (filter: { thread_id: string }) => void
  projectId: string
  research: ResearchSummary[]
  t: Translator
}

/**
 * The Workspace's shared conversation: the default channel as a timeline of
 * topics, with a Thread pane beside it. Execution authority lives elsewhere;
 * nothing here starts an Agent.
 */
export function ChannelWorkspace({
  api,
  connectionState,
  conversations,
  events,
  initialThreadId = null,
  detail = null,
  detailCovers = false,
  focusMessageId = null,
  landing = 'focus',
  onReadingPositionChange,
  filter,
  onFilterChange,
  onThreadChange,
  onOpenTask,
  tasksOnBoard,
  onOpenReference,
  onOpenResearch,
  onOpenSession,
  onOpenWork,
  projectId,
  research,
  t,
}: ChannelWorkspaceProps) {
  const { channel, retry, status } = useDefaultChannel(api, projectId)
  const mentionOptions = useMentionOptions(api, projectId, events, connectionState)
  // Showing only what is about one Task is a view of the same conversation.
  const [localFilter, setLocalFilter] = useState<string | null>(null)
  const taskFilter = filter !== undefined ? filter : localFilter
  const setTaskFilter = useCallback((next: string | null) => {
    setLocalFilter(next)
    onFilterChange?.(next)
  }, [onFilterChange])
  // The unsent draft and its reply target belong to this view of General: its own for each Task.
  const draftKey = placeKey.general(projectId, taskFilter)
  const [replyTo, setReplyTo] = usePlaceState<ChannelMessage | null>(`${draftKey}#replyTo`, null)
  const feed = useMessageFeed(api, projectId, channel?.id ?? null, null, events, connectionState, taskFilter)
  const { reload: reloadThreads, threads } = useChannelThreads(
    api,
    projectId,
    channel?.id ?? null,
    events,
    connectionState,
  )
  const [threadId, setThreadIdState] = useState<string | null>(initialThreadId)
  // The route may open another Thread (Back, a link, the History list).
  const [seenThread, setSeenThread] = useState(initialThreadId)
  if (seenThread !== initialThreadId) {
    setSeenThread(initialThreadId)
    setThreadIdState(initialThreadId)
  }
  const setThreadId = useCallback((next: string | null) => {
    setThreadIdState(next)
    onThreadChange?.(next)
  }, [onThreadChange])
  // A link to an old message: find where it is and load around it.
  const resolved = useRef<string | null>(null)
  // A different scope (another filter) is a new feed: resolve the link again.
  useEffect(() => { resolved.current = null }, [taskFilter, channel?.id])
  const { loadAround, messages: loaded, status: feedStatus } = feed
  useEffect(() => {
    if (!focusMessageId || !channel || feedStatus !== 'ready' || resolved.current === focusMessageId) return
    resolved.current = focusMessageId
    if (loaded.some((message) => message.id === focusMessageId)) return
    api.getChannelMessage(projectId, channel.id, focusMessageId)
      .then((message) => loadAround(message.seq))
      .catch(() => undefined)
  }, [api, channel, feedStatus, focusMessageId, loadAround, loaded, projectId])
  const startThread = useAction(t)
  const sessions = useMemo(() => conversations.filter((item) => (
    item.project_id === projectId
    && !item.archived
    && !item.team_id
    && item.relationship !== 'team_member'
    && item.relationship !== 'subagent'
  )), [conversations, projectId])
  const threadByRoot = useMemo(
    () => new Map(threads.map((thread) => [thread.root_message_id, thread])),
    [threads],
  )
  const thread = threads.find((item) => item.id === threadId) ?? null

  const send = useCallback(async (message: NewChannelMessage) => {
    if (!channel) return
    // Writing while looking at one Task is writing about it, so the message
    // stays in view instead of vanishing from the filtered list.
    const references = taskFilter && !message.references?.some((ref) => ref.kind === 'research' && ref.id === taskFilter)
      ? [...(message.references ?? []), { kind: 'research' as const, id: taskFilter, revision: null }]
      : message.references
    const saved = await api.postChannelMessage(projectId, channel.id, { ...message, references })
    feed.append(saved)
  }, [api, channel, feed, projectId, taskFilter])

  const openThread = (message: ChannelMessage) => {
    const existing = threadByRoot.get(message.id)
    if (existing) {
      setThreadId(existing.id)
      return
    }
    if (!channel) return
    void startThread.run(async () => {
      const started = await api.startChannelThread(projectId, channel.id, message.id)
      reloadThreads()
      setThreadId(started.id)
    })
  }

  // Where the reader is: the list reports the message, focus says composer or message.
  const root = useRef<HTMLElement>(null)
  // Nothing is known of the reading position until the list reports one.
  const reading = useRef<ReadingPosition>({ messageId: null, atLatest: false, focus: null })
  const report = (next: Partial<ReadingPosition>) => {
    const position = { ...reading.current, ...next }
    if (position.messageId === reading.current.messageId
      && position.atLatest === reading.current.atLatest
      && position.focus === reading.current.focus) return
    reading.current = position
    onReadingPositionChange?.(position)
  }
  const noteFocus = (target: EventTarget) => {
    if (!(target instanceof Element)) return
    const focus = target.closest('[data-focus-key^="composer:"]')
      ? 'composer'
      : target.closest('[data-message-id]') ? 'message' : null
    report({ focus })
  }

  // Arriving in the composer: focus it once it is on screen.
  const composerLanded = useRef(false)
  useEffect(() => {
    if (landing !== 'composer') {
      composerLanded.current = false
      return
    }
    if (composerLanded.current || !channel) return
    const box = root.current?.querySelector<HTMLElement>('[data-focus-key="composer:general"]')
    if (!box) return
    composerLanded.current = true
    box.focus({ preventScroll: true })
  }, [channel, landing])

  const openReference = (reference: ProjectContextRef) => {
    if (onOpenReference) onOpenReference(reference)
    else if (reference.kind === 'research') onOpenResearch(reference.id)
    else if (reference.kind === 'session') onOpenSession(reference.id)
    else if (reference.kind === 'thread') setThreadId(reference.id)
  }

  return (
    <section
      aria-label={t('kubecode.channel.title')}
      className="kubecode-channel-workspace"
      data-detail={detail !== null}
      ref={root}
      onFocusCapture={(event) => noteFocus(event.target)}
    >
      <div className="kubecode-channel-main" inert={detail !== null && detailCovers ? true : undefined}>
        <header className="kubecode-channel-header">
          <div>
            <h2>{channel?.is_default ? `# ${t('kubecode.channel.general')}` : channel?.name ?? t('kubecode.channel.title')}</h2>
            <p className="kubecode-research-muted">{t('kubecode.channel.subtitle')}</p>
          </div>
        </header>
        {status === 'error' && (
          <p className="kubecode-research-error" role="alert">
            {t('kubecode.channel.loadFailed')}{' '}
            <Button size="xs" variant="ghost" onClick={retry}>{t('kubecode.retry')}</Button>
          </p>
        )}
        {startThread.error && <p className="kubecode-research-error" role="alert">{startThread.error}</p>}
        {research.length > 0 && (
          <label className="kubecode-channel-filter">
            <span>{t('kubecode.channel.filterTask')}</span>
            <select
              className="kubecode-channel-select"
              value={taskFilter ?? ''}
              onChange={(event) => setTaskFilter(event.target.value || null)}
            >
              <option value="">{t('kubecode.channel.filterAll')}</option>
              {research.map((item) => (
                <option key={item.id} value={item.id}>{item.title}</option>
              ))}
            </select>
          </label>
        )}
        <MessageList
          emptyLabel={t('kubecode.channel.empty')}
          feed={feed}
          label={t('kubecode.channel.messages')}
          research={research}
          sessions={sessions}
          t={t}
          threadByRoot={threadByRoot}
          // While a detail is open the reader is in it; coming back lands on the message again.
          focusId={detail ? null : focusMessageId}
          focusOnLand={landing === 'focus'}
          onReadingPositionChange={(position) => report(position)}
          onFilterTask={setTaskFilter}
          onBoard={tasksOnBoard ? (id) => tasksOnBoard.has(id) : undefined}
          onOpenTask={onOpenTask}
          onOpenReference={openReference}
          onOpenThread={openThread}
          onReply={setReplyTo}
        />
        {channel && (
          <MessageComposer
            api={api}
            draftKey={draftKey}
            focusKey="composer:general"
            mentionOptions={mentionOptions}
            placeholder={t('kubecode.channel.composerPlaceholder')}
            projectId={projectId}
            replyTo={replyTo && {
              id: replyTo.id,
              label: authorName(t, replyTo, sessions),
              // Only the target this send was for: a newer choice stays.
              onClear: () => setReplyTo((current) => (current?.id === replyTo.id ? null : current)),
            }}
            sessions={sessions}
            t={t}
            onSend={send}
          />
        )}
      </div>
      {detail}
      {channel && thread && !detail && (
        <ThreadPane
          api={api}
          channel={channel}
          connectionState={connectionState}
          events={events}
          key={thread.id}
          mentionOptions={mentionOptions}
          research={research}
          sessions={sessions}
          t={t}
          thread={thread}
          onClose={() => setThreadId(null)}
          onOpenReference={openReference}
          onOpenWork={onOpenWork}
          onThreadChanged={reloadThreads}
        />
      )}
    </section>
  )
}
