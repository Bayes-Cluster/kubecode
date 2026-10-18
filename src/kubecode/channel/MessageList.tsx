import { useEffect, useRef } from 'react'

import { Button } from '@/components/ui/button'
import type { Translator } from '@/lib/i18n'

import type { ChannelMessage, ChannelThread, Conversation, ProjectContextRef } from '../api'
import type { MessageFeed } from './useChannel'
import { MessageItem } from './MessageItem'

type MessageListProps = {
  emptyLabel: string
  feed: MessageFeed
  label: string
  onOpenReference?: (reference: ProjectContextRef) => void
  onOpenThread?: (message: ChannelMessage) => void
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
  sessions,
  t,
  threadByRoot,
}: MessageListProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  const newest = feed.messages.at(-1)?.seq ?? 0

  useEffect(() => {
    const element = scroller.current
    if (element && stuck.current) element.scrollTop = element.scrollHeight
  }, [newest])

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
          message={message}
          sessions={sessions}
          t={t}
          thread={threadByRoot?.get(message.id)}
          onOpenReference={onOpenReference}
          onOpenThread={onOpenThread}
        />
      ))}
    </div>
  )
}
