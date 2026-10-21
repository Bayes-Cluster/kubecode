import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { StickToBottomContext } from 'use-stick-to-bottom'

import { Conversation as ConversationScroller, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Button } from '@/components/ui/button'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Separator } from '@/components/ui/separator'
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

/** How long a landing is held in place while the conversation finishes drawing. */
const LANDING_HOLD_MS = 3_000
/** What the reader does to scroll by themselves, which lets a landing go. */
const USER_SCROLL_EVENTS = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const

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
  // The official Conversation scrolls (use-stick-to-bottom, ADR 0242); this keeps its scroller and lock.
  const conversation = useRef<StickToBottomContext | null>(null)
  const scrollerOf = () => conversation.current?.scrollRef.current ?? null
  const stuck = useRef(true)
  // While a landing is held, the Conversation's own scrolling (its first run to the latest,
  // following content that grows) is turned back to the landed message, which makes it let
  // go as it would for a reader scrolling up. The reader's own scroll, or time, ends the hold.
  const releaseLanding = useRef<() => void>(() => undefined)
  useEffect(() => () => releaseLanding.current(), [])
  const holdLanding = (target: HTMLElement) => {
    releaseLanding.current()
    const scroller = scrollerOf()
    if (!scroller) return
    const keep = () => {
      if (!target.isConnected) return
      const box = scroller.getBoundingClientRect()
      const rect = target.getBoundingClientRect()
      if (rect.bottom > box.top && rect.top < box.bottom) return
      target.scrollIntoView?.({ block: 'center' })
    }
    const release = () => {
      window.clearTimeout(timer)
      scroller.removeEventListener('scroll', keep)
      for (const name of USER_SCROLL_EVENTS) scroller.removeEventListener(name, release)
      releaseLanding.current = () => undefined
    }
    const timer = window.setTimeout(release, LANDING_HOLD_MS)
    scroller.addEventListener('scroll', keep, { passive: true })
    for (const name of USER_SCROLL_EVENTS) scroller.addEventListener(name, release, { passive: true })
    releaseLanding.current = release
  }

  const coarse = useCoarsePointer()
  const [announcement, setAnnouncement] = useState('')
  const byId = useMemo(() => new Map(feed.messages.map((message) => [message.id, message])), [feed.messages])
  // The app's language for dates; today is when the list renders.
  const dateLocale = getLocaleDateLocale(locale)
  const items = useMemo(
    () => buildTimeline(feed.messages, { locale: dateLocale, now: new Date(), t }),
    [dateLocale, feed.messages, t],
  )

  /** Scrolls to a message of this feed and, unless told not to, focuses it so the jump is announced. */
  const jump = (messageId: string, focus = true) => {
    const target = scrollerOf()?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`)
    if (!target) {
      onJumpMissing?.(messageId)
      return
    }
    const group = target.closest('details')
    if (group) group.open = true
    stuck.current = false
    // Reading a linked message is leaving the latest: the conversation stops following it.
    conversation.current?.stopScroll()
    target.setAttribute('tabindex', '-1')
    target.scrollIntoView?.({ block: 'center' })
    holdLanding(target)
    if (focus) target.focus({ preventScroll: true })
  }

  // Where the reader is, measured at most once a frame while they scroll.
  const reportRef = useRef(onReadingPositionChange)
  useEffect(() => { reportRef.current = onReadingPositionChange })
  const frame = useRef(0)
  useEffect(() => () => window.cancelAnimationFrame(frame.current), [])
  useEffect(() => {
    const element = scrollerOf()
    if (!element) return undefined
    const onScroll = () => {
      stuck.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
      if (!reportRef.current || frame.current) return
      frame.current = window.requestAnimationFrame(() => {
        frame.current = 0
        reportRef.current?.({ messageId: messageAtMiddle(element), atLatest: stuck.current })
      })
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    return () => element.removeEventListener('scroll', onScroll)
  }, [])

  // Arriving with nothing to land on, the reader starts at the latest, even when the messages
  // were already known (coming back to General) and the Conversation saw no first growth.
  const started = useRef(false)
  const hasMessages = feed.messages.length > 0
  useLayoutEffect(() => {
    if (started.current || !hasMessages) return
    started.current = true
    const element = scrollerOf()
    if (!focusId && element) element.scrollTop = element.scrollHeight
    // Only the first page of messages decides where the reader starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMessages])

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
    // Per Workspace: coming back to another Workspace's General is a new conversation to land in.
    const landing = `${projectId}:${focusId}`
    if (!present || landed.current === landing) return
    landed.current = landing
    // Landing happens once per message; how it lands is read at that moment.
    jump(focusId, focusOnLandRef.current)
    // jump reads the DOM only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, present, projectId])

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

  return (
    <div className="kubecode-message-list">
      <ConversationScroller
        aria-label={label}
        className="kubecode-conversation"
        contextRef={conversation}
        // Arriving to land on a message, the conversation starts where that message is, not at the latest.
        initial={focusId ? false : 'instant'}
        resize="smooth"
      >
        <ConversationContent className="kubecode-conversation-thread" scrollClassName="kubecode-channel-messages">
          {feed.hasMore && (
            <Button
              className="kubecode-load-older"
              disabled={feed.loadingOlder}
              size="xs"
              variant="ghost"
              onClick={() => {
                stuck.current = false
                conversation.current?.stopScroll()
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
            <Empty className="kubecode-conversation-empty">
              <EmptyHeader>
                {emptyIcon && <EmptyMedia aria-hidden="true" variant="icon">{emptyIcon}</EmptyMedia>}
                <EmptyTitle>{emptyLabel}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}
          {items.map((item) => {
            if (item.kind === 'date') {
              return (
                <div className="kubecode-date-separator" key={item.key} role="separator" aria-label={item.label}>
                  <Separator className="kubecode-date-separator-rule" decorative />
                  <span aria-hidden="true">{item.label}</span>
                  <Separator className="kubecode-date-separator-rule" decorative />
                </div>
              )
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
        </ConversationContent>
        <ConversationScrollButton
          aria-label={t('kubecode.vocab.command.latest')}
          className="kubecode-scroll-latest"
          title={t('kubecode.vocab.command.latest')}
        />
      </ConversationScroller>
      <span className="sr-only" role="status">{announcement}</span>
    </div>
  )
}
