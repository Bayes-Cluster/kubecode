import { MarkdownContent } from '@/components/MarkdownContent'
import { IconButton } from '@/components/workspace/IconButton'
import { MoreActions, type MoreActionItem } from '@/components/workspace/MoreActions'
import { ReferenceChip } from '@/components/workspace/ReferenceChip'
import { StatusBadge } from '@/components/workspace/StatusBadge'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS, WORKSPACE_OBJECT_ICONS } from '@/kubecode/icons/workspaceIcons'
import type { Translator } from '@/lib/i18n'

import type { ChannelMessage, ChannelThread, ProjectContextRef } from '../api'
import { Identity } from '../members/Identity'
import type { IdentityView, RecipientsView } from '../members/memberIdentity'
import type { ReferenceLabel } from '../references/referenceLabels'
import { intentLabel } from './channelLabels'
import type { MessageDeliveryView } from './delivery'
import { messageDate } from './timeline'

export type MessageItemProps = {
  message: ChannelMessage
  author: IdentityView
  recipients: RecipientsView
  /** The same author just wrote: the identity is only for assistive technology. */
  continued: boolean
  /** What it replies to: loaded, not loaded (`missing`), or nothing. */
  cited: { author: IdentityView; excerpt: string } | 'missing' | null
  task: { id: string; title: string } | null
  references: Array<ReferenceLabel & { ref: ProjectContextRef }>
  delivery: MessageDeliveryView | null
  /** The Thread an earlier version started on this message. */
  legacyThread?: ChannelThread
  /** Whether a Task is on the board, to say so on its proposal. */
  onBoard?: (taskId: string) => boolean
  /** General already shows only this message's Task. */
  filtered: boolean
  /** A touch screen: one persistent More instead of a hover toolbar. */
  coarse: boolean
  t: Translator
  on: {
    reply?: () => void
    openTask?: () => void
    filterTask?: () => void
    openReference: (ref: ProjectContextRef) => void
    openThread?: () => void
    jump: (messageId: string) => void
    copyLink: () => void
    copyText: () => void
  }
}

const shortTime = (date: Date) => date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/**
 * One message of General (ADR 0229): who wrote it and whom it was for, its
 * Markdown body, the one Task it is about and its titled references, and
 * Reply with the secondary actions behind More. Nothing here starts work.
 */
export function MessageItem({
  author,
  cited,
  coarse,
  continued,
  delivery,
  filtered,
  legacyThread,
  message,
  on,
  onBoard,
  recipients,
  references,
  t,
  task,
}: MessageItemProps) {
  const date = messageDate(message.created_at)
  // The General Agent's proposal of a Task revision (ADR 0221): shown as what it
  // is, with where the Task stands. Nothing here admits it; the researcher says so in words.
  const proposal = message.author_kind === 'agent'
    ? /^proposal:[^:]+:(\d+)/.exec(message.client_message_id ?? '')
    : null
  const replies = legacyThread && legacyThread.reply_count > 0 ? legacyThread.reply_count : 0
  const actions: MoreActionItem[] = [
    ...(coarse && on.reply ? [{ id: 'reply', label: t('kubecode.vocab.command.reply'), onSelect: on.reply }] : []),
    { id: 'copy-link', label: t('kubecode.vocab.command.copyLink'), onSelect: on.copyLink },
    { id: 'copy-text', label: t('kubecode.channel.copyText'), onSelect: on.copyText },
    ...(message.task_id && !filtered && on.filterTask
      ? [{ id: 'filter', label: t('kubecode.channel.showTaskOnly'), onSelect: on.filterTask }]
      : []),
    ...(replies > 0 && on.openThread
      ? [{ id: 'thread', label: t('kubecode.channel.legacyThread.action'), onSelect: on.openThread }]
      : []),
  ]
  const focusKey = `message:${message.id}`
  return (
    <article
      aria-label={author.name}
      className="kubecode-message"
      data-author={message.author_kind}
      data-continued={continued}
      data-focus-key={focusKey}
      data-kind={message.kind}
      data-message-id={message.id}
      data-scroll-anchor={message.id}
      data-testid={`message-${message.seq}`}
      id={`message-${message.id}`}
    >
      <header className="kubecode-message-header">
        <Identity
          className="kubecode-message-author"
          from={focusKey}
          meta={date && (
            <time dateTime={date.toISOString()} title={date.toLocaleString()}>{shortTime(date)}</time>
          )}
          size={continued ? 'sm' : 'md'}
          view={author}
        />
        {message.intent !== 'say' && (
          <StatusBadge tone="muted">
            {intentLabel(t, message.intent)}
            {message.intent_claimed_by ? ` · ${t('kubecode.channel.intent.claimed')}` : ''}
          </StatusBadge>
        )}
        <div className="kubecode-message-toolbar" data-coarse={coarse}>
          {!coarse && on.reply && (
            <IconButton
              icon={<Icon role="command" source={WORKSPACE_COMMAND_ICONS.reply.Icon} />}
              label={t('kubecode.channel.replyTo', { author: author.name })}
              onClick={on.reply}
            />
          )}
          <MoreActions items={actions} label={t('kubecode.channel.messageActions', { author: author.name })} />
        </div>
      </header>
      <div className="kubecode-message-content">
        {cited && message.reply_to && (
          <button
            className="kubecode-channel-citation"
            type="button"
            onClick={() => on.jump(message.reply_to as string)}
          >
            <Icon role="command" size="secondary" source={WORKSPACE_COMMAND_ICONS.reply.Icon} />
            {cited === 'missing'
              ? t('kubecode.channel.citationMissing')
              : t('kubecode.channel.citation', { author: cited.author.name, excerpt: cited.excerpt })}
          </button>
        )}
        {recipients.kind !== 'none' && (
          <p className="kubecode-message-recipients">
            <span className="kubecode-message-recipients-label">
              {recipients.kind === 'members' && recipients.handedOff ? t('kubecode.channel.handedOff') : t('kubecode.channel.to')}
            </span>
            {recipients.kind === 'members'
              ? recipients.members.map((member) => <Identity from={focusKey} key={member.key} size="sm" view={member} />)
              : recipients.manager
                ? <Identity from={focusKey} size="sm" view={recipients.manager} />
                : <span>{t('kubecode.channel.toManager')}</span>}
          </p>
        )}
        {proposal && (
          <p className="kubecode-channel-proposal">
            <StatusBadge tone="info">{t('kubecode.task.proposalBadge', { revision: Number(proposal[1]) })}</StatusBadge>
            {message.task_id && onBoard && (
              <StatusBadge tone={onBoard(message.task_id) ? 'ok' : 'muted'}>
                {onBoard(message.task_id) ? t('kubecode.task.onBoard') : t('kubecode.task.notOnBoardYet')}
              </StatusBadge>
            )}
          </p>
        )}
        <div className="kubecode-message-body">
          <MarkdownContent content={message.body} images="text" />
        </div>
        {proposal && message.task_id && onBoard && !onBoard(message.task_id) && (
          <p className="kubecode-research-muted">{t('kubecode.task.proposalHint')}</p>
        )}
        {(task || references.length > 0) && (
          <ul aria-label={t('kubecode.channel.references')} className="kubecode-message-references">
            {task && (
              <li>
                <ReferenceChip
                  kind="task"
                  kindLabel={t('kubecode.vocab.object.task')}
                  title={task.title}
                  onOpen={on.openTask}
                />
              </li>
            )}
            {references.map((reference) => (
              <li key={`${reference.ref.kind}:${reference.ref.id}`}>
                <ReferenceChip
                  kind={reference.kind}
                  kindLabel={reference.kindLabel}
                  state={reference.state}
                  title={reference.title}
                  version={reference.version}
                  onOpen={() => on.openReference(reference.ref)}
                />
              </li>
            ))}
          </ul>
        )}
        {replies > 0 && on.openThread && (
          <button className="kubecode-legacy-thread-link" type="button" onClick={on.openThread}>
            <Icon role="identity" size="secondary" source={WORKSPACE_OBJECT_ICONS.thread.Icon} />
            {t('kubecode.channel.legacyThread.open', { count: replies })}
          </button>
        )}
        {delivery?.state === 'failed' && (
          <p className="kubecode-message-delivery" data-delivery="failed">
            <StatusBadge tone="danger">{t('kubecode.channel.notDelivered')}</StatusBadge>
            <span>{delivery.text}</span>
          </p>
        )}
      </div>
    </article>
  )
}
