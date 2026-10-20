import type { Translator } from '@/lib/i18n'

import type { ChannelMessage } from '../api'
import { messageDate, shortTime } from './timeline'

/**
 * A run of routine Kubecode notes (routing, hand-offs) collapsed into one
 * line until asked for (ADR 0229 §7). Each note keeps its anchors, so a link
 * or a citation can still land on it.
 */
export function ActivityGroup({ dateLocale, messages, t }: { dateLocale: string; messages: ChannelMessage[]; t: Translator }) {
  return (
    <details className="kubecode-activity-group">
      <summary>{t('kubecode.channel.activityGroup', { count: messages.length })}</summary>
      <ul>
        {messages.map((message) => {
          const date = messageDate(message.created_at)
          return (
            <li
              data-author="system"
              data-focus-key={`message:${message.id}`}
              data-message-id={message.id}
              data-scroll-anchor={message.id}
              data-testid={`message-${message.seq}`}
              id={`message-${message.id}`}
              key={message.id}
            >
              <span>{message.body}</span>
              {date && <time dateTime={date.toISOString()}>{shortTime(date, dateLocale)}</time>}
            </li>
          )
        })}
      </ul>
    </details>
  )
}
