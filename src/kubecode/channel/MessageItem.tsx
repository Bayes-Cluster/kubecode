import { CornerUpLeft, MessageSquareText } from 'lucide-react'

import { IconButton } from '@/components/workspace/IconButton'
import { StatusBadge } from '@/components/workspace/StatusBadge'
import { Button } from '@/components/ui/button'
import type { Translator } from '@/lib/i18n'

import type {
  ChannelMessage,
  ChannelThread,
  Conversation,
  ProjectContextRef,
  ResearchSummary,
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
  /** The message this one cites, when it is loaded. */
  cited?: ChannelMessage | null
  /** Research questions, to name the Task a message is about. */
  research?: ResearchSummary[]
  /** Cites this message in the next one. */
  onReply?: (message: ChannelMessage) => void
  /** Scrolls to the message this one cites. */
  onJump?: (messageId: string) => void
  /** Shows only the messages about this Task. */
  onFilterTask?: (taskId: string) => void
}

/** One immutable message: who wrote it, what it points at, and its Thread. */
export function MessageItem({
  cited = null,
  message,
  onFilterTask,
  onJump,
  onOpenReference,
  onOpenThread,
  onReply,
  research = [],
  sessions,
  t,
  thread,
}: MessageItemProps) {
  const sessionTitle = (id: string) => sessions.find((item) => item.id === id)?.title ?? id.slice(0, 8)
  const task = message.task_id ? research.find((item) => item.id === message.task_id) : undefined
  if (message.author_kind === 'system') {
    // Routing notes and similar low-level activity stay out of the way until asked for.
    return (
      <details
        className="kubecode-channel-activity"
        data-author="system"
        data-message-id={message.id}
        data-testid={`message-${message.seq}`}
      >
        <summary title={t('kubecode.channel.activity')}>
          {message.body.length > 90 ? `${message.body.slice(0, 90)}…` : message.body}
        </summary>
        {message.body.length > 90 && <p className="kubecode-channel-body">{message.body}</p>}
      </details>
    )
  }
  return (
    <article
      className="kubecode-channel-message"
      data-author={message.author_kind}
      data-kind={message.kind}
      data-message-id={message.id}
      data-testid={`message-${message.seq}`}
      id={`message-${message.id}`}
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
      {message.reply_to && (
        <button
          className="kubecode-channel-citation"
          disabled={!cited}
          type="button"
          onClick={() => onJump?.(message.reply_to as string)}
        >
          <CornerUpLeft aria-hidden size={12} />
          {cited
            ? t('kubecode.channel.citation', {
              author: authorName(t, cited, sessions),
              excerpt: cited.body.length > 80 ? `${cited.body.slice(0, 80)}…` : cited.body,
            })
            : t('kubecode.channel.citationMissing')}
        </button>
      )}
      <p className="kubecode-channel-body">{message.body}</p>
      {message.mentions.length > 0 && (
        <p className="kubecode-channel-mentions">
          {message.author_kind === 'agent'
            ? t('kubecode.channel.handedTo', {
              names: message.mentions.map((mention) => `@${sessionTitle(mention.session_id)}`).join(' '),
            })
            : message.mentions.map((mention) => `@${sessionTitle(mention.session_id)}`).join(' ')}
        </p>
      )}
      {message.task_id && (
        <p className="kubecode-channel-task">
          {onFilterTask ? (
            <button
              className="kubecode-channel-reference"
              type="button"
              onClick={() => onFilterTask(message.task_id as string)}
            >
              {t('kubecode.channel.taskChip', { title: task?.title ?? message.task_id.slice(0, 8) })}
            </button>
          ) : (
            <span className="kubecode-channel-reference">
              {t('kubecode.channel.taskChip', { title: task?.title ?? message.task_id.slice(0, 8) })}
            </span>
          )}
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
      {onReply && message.kind === 'message' && (
        <IconButton
          icon={<CornerUpLeft aria-hidden size={14} />}
          label={t('kubecode.channel.replyToMessage')}
          onClick={() => onReply(message)}
        />
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
