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
  /** A message to scroll to and focus once it is loaded (a link, or coming back from a Task). */
  focusId?: string | null
  research?: ResearchSummary[]
  sessions: Conversation[]
  t: Translator
  threadByRoot?: Map<string, ChannelThread>
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
  focusId = null,
  onReply,
  research,
  sessions,
  t,
  threadByRoot,
}: MessageListProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  const newest = feed.messages.at(-1)?.seq ?? 0
  const byId = new Map(feed.messages.map((message) => [message.id, message]))

  /** Scrolls to a message of this feed and focuses it so the jump is announced. */
  const jump = (messageId: string) => {
    const target = scroller.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`)
    if (!target) return
    stuck.current = false
    target.setAttribute('tabindex', '-1')
    target.scrollIntoView?.({ block: 'center' })
    target.focus({ preventScroll: true })
  }

  useEffect(() => {
    const element = scroller.current
    if (element && stuck.current) element.scrollTop = element.scrollHeight
  }, [newest])

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
    jump(focusId)
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
          onOpenTask={onOpenTask}
          onOpenReference={onOpenReference}
          onOpenThread={onOpenThread}
          onReply={onReply}
        />
      ))}
    </div>
  )
}
