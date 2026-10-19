import { MessageSquareText } from 'lucide-react'

import { StatusBadge } from '@/components/workspace/StatusBadge'
import { Button } from '@/components/ui/button'
import type { Translator } from '@/lib/i18n'

import type {
  ChannelMessage,
  ChannelThread,
  Conversation,
  ProjectContextRef,
} from '../api'
import { PROJECT_CONTEXT_KIND_LABELS } from '../projectContext'
import { authorName, intentLabel, messageTime } from './channelLabels'

export type MessageItemProps = {
  message: ChannelMessage
  /** Sessions of the Project, to name mentioned and writing Sessions. */
  sessions: Conversation[]
  t: Translator
  /** The Thread rooted at this message, when there is one. */
  thread?: ChannelThread
  /** Opens or starts the Thread on this message; omitted inside a Thread. */
  onOpenThread?: (message: ChannelMessage) => void
  onOpenReference?: (reference: ProjectContextRef) => void
}

/** One immutable message: who wrote it, what it points at, and its Thread. */
export function MessageItem({
  message,
  onOpenReference,
  onOpenThread,
  sessions,
  t,
  thread,
}: MessageItemProps) {
  const sessionTitle = (id: string) => sessions.find((item) => item.id === id)?.title ?? id.slice(0, 8)
  return (
    <article
      className="kubecode-channel-message"
      data-author={message.author_kind}
      data-kind={message.kind}
      data-testid={`message-${message.seq}`}
    >
      <header>
        <strong>{authorName(t, message, sessions)}</strong>
        <time dateTime={message.created_at}>{messageTime(message.created_at)}</time>
        {message.intent !== 'say' && (
          <StatusBadge tone="info">
            {intentLabel(t, message.intent)}
            {message.intent_claimed_by ? ` · ${t('kubecode.channel.intent.claimed')}` : ''}
          </StatusBadge>
        )}
      </header>
      <p className="kubecode-channel-body">{message.body}</p>
      {message.mentions.length > 0 && (
        <p className="kubecode-channel-mentions">
          {message.mentions.map((mention) => `@${sessionTitle(mention.session_id)}`).join(' ')}
        </p>
      )}
      {message.references.length > 0 && (
        <ul className="kubecode-channel-references" aria-label={t('kubecode.channel.references')}>
          {message.references.map((reference) => (
            <li key={`${reference.kind}:${reference.id}`}>
              <button
                className="kubecode-channel-reference"
                disabled={!onOpenReference}
                type="button"
                onClick={() => onOpenReference?.(reference)}
              >
                {t(PROJECT_CONTEXT_KIND_LABELS[reference.kind])}
                <span>{reference.id.slice(0, 8)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {onOpenThread && message.kind === 'message' && (
        <Button
          className="kubecode-channel-thread-button"
          size="xs"
          variant="ghost"
          onClick={() => onOpenThread(message)}
        >
          <MessageSquareText aria-hidden size={14} />
          {thread && thread.reply_count > 0
            ? t('kubecode.channel.replies', { count: thread.reply_count })
            : t('kubecode.channel.reply')}
        </Button>
      )}
    </article>
  )
}
