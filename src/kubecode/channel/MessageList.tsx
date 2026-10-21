import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ConversationEmptyState } from '@/components/ai-elements'

import { Button } from '@/components/ui/button'
import { DEFAULT_APP_LOCALE, getLocaleDateLocale, type AppLocale, type Translator } from '@/lib/i18n'

import type {
  ChannelMessage,
  ChannelThread,
  Conversation,
  ProjectContextRef,
  ResearchSummary,
} from '../api'
import { routeHash } from '../app/workspaceRoute'
import type { MemberDirectory } from '../members/memberDirectory'
import { authorView, messageRecipients, type IdentityView } from '../members/memberIdentity'
import type { ReferenceLabelSource } from '../references/referenceLabels'
import { ActivityGroup } from './ActivityGroup'
import { notesDelivery, type MessageDeliverySource } from './delivery'
import { excerptOf } from './generalDraft'
import { MessageItem } from './MessageItem'
import { buildTimeline, displayReferences } from './timeline'
import type { MessageFeed } from './useChannel'
import { useCoarsePointer } from './useCoarsePointer'

type MessageListProps = {
  emptyLabel: string
  /** Shown above the empty label, as in the #230 prototypes. */
  emptyIcon?: ReactNode
  feed: MessageFeed
  label: string
  /** The app's language: dates and times follow it, as Today and Yesterday do. */
  locale?: AppLocale
  projectId: string
  directory: MemberDirectory
  /** Sessions of the Project, to name an agent that is no member. */
  sessions: Conversation[]
  labels: ReferenceLabelSource
  research?: ResearchSummary[]
  t: Translator
  threadByRoot?: Map<string, ChannelThread>
  delivery?: MessageDeliverySource
  /** The Task General shows only, if any. */
  filter?: string | null
  /** Cites a message in the General draft; absent where nothing can be written (a Thread). */
  onReply?: (message: ChannelMessage, author: IdentityView) => void
  onFilterTask?: (taskId: string) => void
  /** Opens the Task a message is about. */
  onOpenTask?: (taskId: string, messageId: string) => void
  onBoard?: (taskId: string) => boolean
  onOpenReference: (reference: ProjectContextRef) => void
  onOpenThread?: (thread: ChannelThread) => void
  /** A citation of a message that is not loaded: load around it and land there. */
  onJumpMissing?: (messageId: string) => void
  /** A message to scroll to and focus once it is loaded (a link, or coming back from a Task). */
  focusId?: string | null
  /**
   * Where the reader is (ADR 0228 §4): the message across the middle of the
   * log, and whether they are at the newest one. Reported as they scroll.
   */
  onReadingPositionChange?: (position: { messageId: string | null; atLatest: boolean }) => void
  /** Whether landing on `focusId` also focuses it (a link) or only scrolls (coming back). */
  focusOnLand?: boolean
}

/** The message whose row is nearest the middle of the scroller. */
function messageAtMiddle(scroller: HTMLElement): string | null {
  const box = scroller.getBoundingClientRect()
  const middle = box.top + (box.bottom - box.top) / 2
  let best: { id: string; distance: number } | null = null
  for (const row of scroller.querySelectorAll<HTMLElement>('[data-message-id]')) {
    const rect = row.getBoundingClientRect()
    const distance = middle < rect.top ? rect.top - middle : middle > rect.bottom ? middle - rect.bottom : 0
    if (!best || distance < best.distance) best = { id: row.dataset.messageId ?? '', distance }
    if (distance === 0) break
  }
  return best?.id ?? null
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/**
 * General as a scrollable timeline that stays at the bottom while the reader
 * is (ADR 0229 §7): days apart, one author's messages together, routine notes
 * collapsed, and each message with its identity, recipients, and actions.
 */
export function MessageList({
  delivery = notesDelivery,
  directory,
  emptyLabel,
  emptyIcon,
  feed,
  filter = null,
  focusId = null,
  focusOnLand = true,
  label,
  labels,
  locale = DEFAULT_APP_LOCALE,
  onBoard,
  onFilterTask,
  onJumpMissing,
  onOpenReference,
  onOpenTask,
  onOpenThread,
  onReadingPositionChange,
  onReply,
  projectId,
  research = [],
  sessions,
  t,
  threadByRoot,
}: MessageListProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  const coarse = useCoarsePointer()
  const [announcement, setAnnouncement] = useState('')
  const [unseen, setUnseen] = useState(false)
  const newest = feed.messages.at(-1)?.seq ?? 0
  const byId = useMemo(() => new Map(feed.messages.map((message) => [message.id, message])), [feed.messages])
  // The app's language for dates; today is when the list renders.
  const dateLocale = getLocaleDateLocale(locale)
  const items = useMemo(
    () => buildTimeline(feed.messages, { locale: dateLocale, now: new Date(), t }),
    [dateLocale, feed.messages, t],
  )

  /** Scrolls to a message of this feed and, unless told not to, focuses it so the jump is announced. */
  const jump = (messageId: string, focus = true) => {
    const target = scroller.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`)
    if (!target) {
      onJumpMissing?.(messageId)
      return
    }
    const group = target.closest('details')
    if (group) group.open = true
    stuck.current = false
    target.setAttribute('tabindex', '-1')
    target.scrollIntoView?.({ block: 'center' })
    if (focus) target.focus({ preventScroll: true })
  }

  // Where the reader is, measured at most once a frame while they scroll.
  const reportRef = useRef(onReadingPositionChange)
  useEffect(() => { reportRef.current = onReadingPositionChange })
  const frame = useRef(0)
  useEffect(() => () => window.cancelAnimationFrame(frame.current), [])
  const measure = () => {
    if (!reportRef.current || frame.current) return
    frame.current = window.requestAnimationFrame(() => {
      frame.current = 0
      const element = scroller.current
      if (element) reportRef.current?.({ messageId: messageAtMiddle(element), atLatest: stuck.current })
    })
  }

  // Following the conversation keeps the newest in view; reading back, a newer message is pointed out instead.
  const [seenNewest, setSeenNewest] = useState(newest)
  if (seenNewest !== newest) {
    setSeenNewest(newest)
    if (newest > seenNewest && !stuck.current) setUnseen(true)
  }
  useEffect(() => {
    const element = scroller.current
    if (element && stuck.current) element.scrollTop = element.scrollHeight
  }, [newest])

  const focusOnLandRef = useRef(focusOnLand)
  useEffect(() => { focusOnLandRef.current = focusOnLand })

  // Land on a linked message once, when it is in the loaded page.
  const landed = useRef<string | null>(null)
  const present = focusId !== null && byId.has(focusId)
  useEffect(() => {
    if (!focusId) {
      landed.current = null
      return
    }
    if (!present || landed.current === focusId) return
    landed.current = focusId
    // Landing happens once per message; how it lands is read at that moment.
    jump(focusId, focusOnLandRef.current)
    // jump reads the DOM only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, present])

  const copyLink = (message: ChannelMessage) => {
    const link = `${window.location.origin}${window.location.pathname}${window.location.search}${routeHash({
      project: projectId,
      view: 'general',
      message: message.id,
    })}`
    void copy(link).then((ok) => setAnnouncement(ok ? t('kubecode.channel.linkCopied') : t('kubecode.channel.copyFailed')))
  }
  const copyText = (message: ChannelMessage) => {
    void copy(message.body).then((ok) => setAnnouncement(ok ? t('kubecode.channel.textCopied') : t('kubecode.channel.copyFailed')))
  }

  const toLatest = () => {
    const element = scroller.current
    stuck.current = true
    setUnseen(false)
    if (element) element.scrollTop = element.scrollHeight
  }

  return (
    <div className="kubecode-message-list">
      <div
        aria-label={label}
        className="kubecode-channel-messages"
        ref={scroller}
        role="log"
        onScroll={(event) => {
          const element = event.currentTarget
          stuck.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
          if (stuck.current && unseen) setUnseen(false)
          measure()
        }}
      >
        {feed.hasMore && (
          <Button
            disabled={feed.loadingOlder}
            size="xs"
            variant="ghost"
            onClick={() => {
              stuck.current = false
              feed.loadOlder()
            }}
          >
            {t('kubecode.channel.loadOlder')}
          </Button>
        )}
        {feed.status === 'loading' && (
          <p className="kubecode-research-muted" role="status">{t('kubecode.channel.loading')}</p>
        )}
        {feed.status === 'error' && (
          <p className="kubecode-research-error" role="alert">
            {t('kubecode.channel.loadFailed')}{' '}
            <Button size="xs" variant="ghost" onClick={feed.reload}>{t('kubecode.retry')}</Button>
          </p>
        )}
        {feed.status === 'ready' && feed.messages.length === 0 && (
          <ConversationEmptyState icon={emptyIcon} title={emptyLabel} />
        )}
        {items.map((item) => {
          if (item.kind === 'date') {
            return <p className="kubecode-date-separator" key={item.key} role="separator">{item.label}</p>
          }
          if (item.kind === 'activity') return <ActivityGroup dateLocale={dateLocale} key={item.key} messages={item.messages} t={t} />
          const { message } = item
          const author = authorView(message, directory, sessions, t)
          const citedMessage = message.reply_to ? byId.get(message.reply_to) : undefined
          const taskId = message.task_id
          const thread = threadByRoot?.get(message.id)
          return (
            <MessageItem
              author={author}
              cited={message.reply_to
                ? citedMessage
                  ? { author: authorView(citedMessage, directory, sessions, t), excerpt: excerptOf(citedMessage.body) }
                  : 'missing'
                : null}
              coarse={coarse}
              continued={item.continued}
              dateLocale={dateLocale}
              delivery={delivery(message, item.notes)}
              filtered={filter !== null && filter === taskId}
              key={message.id}
              legacyThread={thread}
              message={message}
              recipients={messageRecipients(message, directory, sessions, t)}
              references={displayReferences(message).map((ref) => ({ ...labels(ref), ref }))}
              t={t}
              task={taskId ? { id: taskId, title: research.find((entry) => entry.id === taskId)?.title ?? labels({ kind: 'research', id: taskId }).title } : null}
              onBoard={onBoard}
              on={{
                reply: onReply && message.thread_id === null ? () => onReply(message, author) : undefined,
                openTask: taskId && (onOpenTask || onFilterTask)
                  ? () => (onOpenTask ? onOpenTask(taskId, message.id) : onFilterTask?.(taskId))
                  : undefined,
                filterTask: taskId && onFilterTask ? () => onFilterTask(taskId) : undefined,
                openReference: onOpenReference,
                openThread: thread && onOpenThread ? () => onOpenThread(thread) : undefined,
                jump: (id) => jump(id),
                copyLink: () => copyLink(message),
                copyText: () => copyText(message),
              }}
            />
          )
        })}
      </div>
      {unseen && (
        <Button className="kubecode-new-messages" size="xs" variant="secondary" onClick={toLatest}>
          {t('kubecode.channel.newMessages')}
        </Button>
      )}
      <span className="sr-only" role="status">{announcement}</span>
    </div>
  )
}
