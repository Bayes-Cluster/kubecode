import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { ReferenceChip } from '@/components/workspace/ReferenceChip'
import { ViewHeader } from '@/components/workspace/ViewHeader'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_DESTINATION_ICONS } from '@/kubecode/icons/workspaceIcons'
import type { Translator } from '@/lib/i18n'

import type {
  ChannelMessage,
  ChannelThread,
  Conversation,
  KubecodeApi,
  NewChannelMessage,
  ProjectContextRef,
  ResearchSummary,
  WorkspaceEvent,
} from '../api'
import { placeKey, usePlaceState, type Landing, type ReadingPosition } from '../app/location/placeMemory'
import { WorkspaceNavigationContext } from '../app/location/WorkspaceNavigation'
import { useMemberDirectory } from '../members/memberDirectory'
import { authorView, type IdentityView } from '../members/memberIdentity'
import { localReferenceLabels } from '../references/referenceLabels'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'
import { notesDelivery, type MessageDeliverySource } from './delivery'
import { emptyGeneralDraft, withReply, type GeneralDraft } from './generalDraft'
import { MessageComposer } from './MessageComposer'
import { MessageList } from './MessageList'
import { ThreadPane } from './ThreadPane'
import { useChannelThreads, useDefaultChannel, useMessageFeed } from './useChannel'

export type ChannelWorkspaceProps = {
  api: KubecodeApi
  connectionState: WorkspaceConnectionState
  /** Sessions of every Project; filtered to this one here, to name agents that are no member. */
  conversations: Conversation[]
  events: WorkspaceEvent[]
  /** An earlier Thread to open on arrival (a link, execution history). */
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
   * Opens a reference chip where references open everywhere (ADR 0228 §3).
   * Without it, the Workspace navigation opens it.
   */
  onOpenReference?: (reference: ProjectContextRef) => void
  /** Opens the one work board filtered to what came from a Thread. */
  onOpenWork?: (filter: { thread_id: string }) => void
  /** What the conversation says about a message's delivery (#220 replaces the default). */
  delivery?: MessageDeliverySource
  projectId: string
  research: ResearchSummary[]
  t: Translator
}

/**
 * The Workspace's shared conversation, General (ADR 0229): one timeline in
 * which every message is plain, names whom it is for, and replies by citing.
 * Earlier Threads open beside it, read-only. Execution authority lives
 * elsewhere; nothing here starts an Agent or a Task.
 */
export function ChannelWorkspace({
  api,
  connectionState,
  conversations,
  delivery = notesDelivery,
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
  onOpenWork,
  projectId,
  research,
  t,
}: ChannelWorkspaceProps) {
  const { channel, retry, status } = useDefaultChannel(api, projectId)
  const directory = useMemberDirectory()
  const navigation = useContext(WorkspaceNavigationContext)
  // Showing only what is about one Task is a view of the same conversation.
  const [localFilter, setLocalFilter] = useState<string | null>(null)
  const taskFilter = filter !== undefined ? filter : localFilter
  const [outside, setOutside] = useState<string | null>(null)
  const setTaskFilter = useCallback((next: string | null) => {
    setLocalFilter(next)
    setOutside(null)
    onFilterChange?.(next)
  }, [onFilterChange])
  // The unsent message belongs to this view of General: each Task-scoped view has its own.
  const [draft, setDraft] = usePlaceState<GeneralDraft>(
    `${placeKey.general(projectId, taskFilter)}#draft`,
    emptyGeneralDraft(taskFilter),
  )
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
  // A citation of a message that is not loaded: load around it, then land there.
  const [jumpTarget, setJumpTarget] = useState<string | null>(null)
  const [seenFocus, setSeenFocus] = useState(focusMessageId)
  if (seenFocus !== focusMessageId) {
    setSeenFocus(focusMessageId)
    setJumpTarget(null)
  }
  const jumpMissing = (messageId: string) => {
    if (!channel) return
    api.getChannelMessage(projectId, channel.id, messageId)
      .then((message) => {
        loadAround(message.seq)
        setJumpTarget(messageId)
      })
      .catch(() => undefined)
  }
  const sessions = useMemo(() => conversations.filter((item) => item.project_id === projectId), [conversations, projectId])
  const threadByRoot = useMemo(
    () => new Map(threads.map((thread) => [thread.root_message_id, thread])),
    [threads],
  )
  const thread = threads.find((item) => item.id === threadId) ?? null
  const labels = useMemo(
    () => localReferenceLabels({ research, threads, sessions, picked: draft.references, t }),
    [draft.references, research, sessions, t, threads],
  )

  const send = useCallback(async (message: NewChannelMessage): Promise<ChannelMessage> => {
    if (!channel) throw new Error(t('kubecode.channel.loadFailed'))
    const saved = await api.postChannelMessage(projectId, channel.id, message)
    // A message that is not about the Task shown is sent, but not shown here.
    if (!taskFilter || saved.task_id === taskFilter) feed.append(saved)
    return saved
  }, [api, channel, feed, projectId, t, taskFilter])

  const sent = (saved: ChannelMessage) => {
    setOutside(taskFilter && saved.task_id !== taskFilter ? taskFilter : null)
  }

  // Reply cites the message in the General draft, then puts the caret at the end of the text.
  const textarea = useRef<HTMLTextAreaElement | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [focusRequest, setFocusRequest] = useState(0)
  useEffect(() => {
    if (focusRequest === 0) return
    const box = textarea.current
    if (!box) return
    box.focus()
    box.setSelectionRange(box.value.length, box.value.length)
  }, [focusRequest])
  const reply = (message: ChannelMessage, author: IdentityView) => {
    setDraft((current) => withReply(current, message, author, directory))
    setAnnouncement(t('kubecode.channel.replyingTo', { author: author.name }))
    setFocusRequest((count) => count + 1)
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
    else if (navigation) navigation.openReference(reference)
    else if (reference.kind === 'thread') setThreadId(reference.id)
  }
  const openThread = (chosen: ChannelThread) => setThreadId(chosen.id)
  const filterTitle = taskFilter ? labels({ kind: 'research', id: taskFilter }).title : null
  const outsideTitle = outside ? labels({ kind: 'research', id: outside }).title : null

  return (
    <section
      aria-label={t('kubecode.channel.title')}
      className="kubecode-channel-workspace"
      data-detail={detail !== null}
      ref={root}
      onFocusCapture={(event) => noteFocus(event.target)}
    >
      <div className="kubecode-channel-main" inert={detail !== null && detailCovers ? true : undefined}>
        <ViewHeader
          className="kubecode-channel-header"
          description={t('kubecode.channel.description')}
          icon={<Icon role="navigation" source={WORKSPACE_DESTINATION_ICONS.general.Icon} />}
          meta={research.length > 0 || taskFilter ? (
            <div className="kubecode-channel-filter">
              {research.length > 0 && (
                <label>
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
              {taskFilter && filterTitle && (
                <ReferenceChip
                  kind="task"
                  kindLabel={t('kubecode.vocab.object.task')}
                  removeLabel={t('kubecode.channel.showEverything')}
                  title={filterTitle}
                  onRemove={() => setTaskFilter(null)}
                />
              )}
            </div>
          ) : undefined}
          title={channel && !channel.is_default ? channel.name : t('kubecode.channel.general')}
        />
        {status === 'error' && (
          <p className="kubecode-research-error" role="alert">
            {t('kubecode.channel.loadFailed')}{' '}
            <Button size="xs" variant="ghost" onClick={retry}>{t('kubecode.retry')}</Button>
          </p>
        )}
        <MessageList
          delivery={delivery}
          directory={directory}
          emptyLabel={t('kubecode.channel.empty')}
          feed={feed}
          filter={taskFilter}
          // While a detail is open the reader is in it; coming back lands on the message again.
          focusId={detail ? null : jumpTarget ?? focusMessageId}
          focusOnLand={jumpTarget !== null || landing === 'focus'}
          label={t('kubecode.channel.messages')}
          labels={labels}
          projectId={projectId}
          research={research}
          sessions={sessions}
          t={t}
          threadByRoot={threadByRoot}
          onBoard={tasksOnBoard ? (id) => tasksOnBoard.has(id) : undefined}
          onFilterTask={setTaskFilter}
          onJumpMissing={jumpMissing}
          onOpenReference={openReference}
          onOpenTask={onOpenTask}
          onOpenThread={openThread}
          onReadingPositionChange={(position) => report(position)}
          onReply={reply}
        />
        {outside && outsideTitle && (
          <p className="kubecode-channel-outside" role="status">
            {t('kubecode.channel.notInFilter', { title: outsideTitle })}{' '}
            <Button size="xs" variant="ghost" onClick={() => setTaskFilter(null)}>
              {t('kubecode.channel.showEverything')}
            </Button>
          </p>
        )}
        <span className="sr-only" role="status">{announcement}</span>
        {channel && (
          <MessageComposer
            api={api}
            directory={directory}
            draft={draft}
            focusKey="composer:general"
            labels={labels}
            placeholder={t('kubecode.channel.composerPlaceholder')}
            projectId={projectId}
            t={t}
            textareaRef={textarea}
            onDraftChange={setDraft}
            onSend={send}
            onSent={sent}
          />
        )}
      </div>
      {detail}
      {channel && thread && !detail && (
        <ThreadPane
          api={api}
          channel={channel}
          connectionState={connectionState}
          directory={directory}
          events={events}
          key={thread.id}
          labels={labels}
          research={research}
          sessions={sessions}
          t={t}
          thread={thread}
          onClose={() => setThreadId(null)}
          onOpenReference={openReference}
          onOpenWork={onOpenWork}
          onReplyInGeneral={(message) => {
            setThreadId(null)
            reply(message, authorView(message, directory, sessions, t))
          }}
          onThreadChanged={reloadThreads}
        />
      )}
    </section>
  )
}
