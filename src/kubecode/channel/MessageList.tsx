import { useEffect, useRef } from 'react'

import { Button } from '@/components/ui/button'
import type { Translator } from '@/lib/i18n'

import type {
  ChannelMessage,
  ChannelThread,
  Conversation,
  ProjectContextRef,
  ResearchSummary,
} from '../api'
import type { MessageFeed } from './useChannel'
import { MessageItem } from './MessageItem'

type MessageListProps = {
  emptyLabel: string
  feed: MessageFeed
  label: string
  onOpenReference?: (reference: ProjectContextRef) => void
  onOpenThread?: (message: ChannelMessage) => void
  onReply?: (message: ChannelMessage) => void
  onFilterTask?: (taskId: string) => void
  /** Opens the Task a message is about. */
  onOpenTask?: (taskId: string, messageId: string) => void
  onBoard?: (taskId: string) => boolean
  /** A message to scroll to and focus once it is loaded (a link, or coming back from a Task). */
  focusId?: string | null
  research?: ResearchSummary[]
  sessions: Conversation[]
  t: Translator
  threadByRoot?: Map<string, ChannelThread>
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

/** A scrollable page of messages that stays at the bottom while the reader is. */
export function MessageList({
  emptyLabel,
  feed,
  label,
  onOpenReference,
  onOpenThread,
  onFilterTask,
  onOpenTask,
  onBoard,
  focusId = null,
  onReply,
  research,
  sessions,
  t,
  threadByRoot,
  onReadingPositionChange,
  focusOnLand = true,
}: MessageListProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  const newest = feed.messages.at(-1)?.seq ?? 0
  const byId = new Map(feed.messages.map((message) => [message.id, message]))

  /** Scrolls to a message of this feed and, unless told not to, focuses it so the jump is announced. */
  const jump = (messageId: string, focus = true) => {
    const target = scroller.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`)
    if (!target) return
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

  useEffect(() => {
    const element = scroller.current
    if (element && stuck.current) element.scrollTop = element.scrollHeight
  }, [newest])

  const focusOnLandRef = useRef(focusOnLand)
  useEffect(() => { focusOnLandRef.current = focusOnLand })

  // Land on a linked message once, when it is in the loaded page.
  const landed = useRef<string | null>(null)
  const present = focusId !== null && feed.messages.some((message) => message.id === focusId)
  useEffect(() => {
    if (!focusId) {
      landed.current = null
      return
    }
    if (!present || landed.current === focusId) return
    landed.current = focusId
    // Landing happens once per message; how it lands is read at that moment.
    jump(focusId, focusOnLandRef.current)
  }, [focusId, present])

  return (
    <div
      aria-label={label}
      className="kubecode-channel-messages"
      ref={scroller}
      role="log"
      onScroll={(event) => {
        const element = event.currentTarget
        stuck.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
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
        <p className="kubecode-research-muted">{emptyLabel}</p>
      )}
      {feed.messages.map((message) => (
        <MessageItem
          key={message.id}
          cited={message.reply_to ? byId.get(message.reply_to) ?? null : null}
          message={message}
          research={research}
          sessions={sessions}
          t={t}
          thread={threadByRoot?.get(message.id)}
          onFilterTask={onFilterTask}
          onJump={jump}
          onBoard={onBoard}
          onOpenTask={onOpenTask}
          onOpenReference={onOpenReference}
          onOpenThread={onOpenThread}
          onReply={onReply}
        />
      ))}
    </div>
  )
}
