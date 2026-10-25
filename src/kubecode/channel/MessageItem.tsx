import { MessageAction, MessageActions, MessageContent } from '@/components/ai-elements/message'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { MoreActions, type MoreActionItem } from '@/components/workspace/MoreActions'
import { ReferenceChip } from '@/components/workspace/ReferenceChip'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS, WORKSPACE_OBJECT_ICONS } from '@/kubecode/icons/workspaceIcons'
import type { Translator } from '@/lib/i18n'

import type { ChannelMessage, ChannelThread, ProjectContextRef } from '../api'
import { DeliveryStatus } from '../attention/DeliveryStatus'
import { Identity } from '../members/Identity'
import type { IdentityView, RecipientsView } from '../members/memberIdentity'
import type { ReferenceLabel } from '../references/referenceLabels'
import { ReferenceSources } from '../resources/ReferenceSources'
import { intentLabel } from './channelLabels'
import { ConversationMessage } from './ConversationMessage'
import { ConversationResponse } from './ConversationResponse'
import type { MessageDeliveryView } from './delivery'
import { messageDate, shortTime } from './timeline'


/** A recipient in the researcher's own meta line: the name alone, on one line. */
function nameOnly(view: IdentityView): IdentityView {
  return { ...view, handle: undefined, roleLabel: undefined }
}
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
  /** The app language's date locale (`getLocaleDateLocale`), never the browser's. */
  dateLocale: string
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

/** A delivery the source reports, in words and quietly: who it is waiting to reach, or reached. */
function deliveryText(state: 'queued' | 'delivered', recipients: string[], locale: string, t: Translator): string {
  if (recipients.length === 0) {
    return state === 'queued' ? t('kubecode.channel.delivery.queued') : t('kubecode.channel.delivery.delivered')
  }
  const names = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(recipients)
  return state === 'queued'
    ? t('kubecode.channel.delivery.queuedTo', { names })
    : t('kubecode.channel.delivery.deliveredTo', { names })
}

/** How far the message got, as the conversation draws it: failed, still on its way, or settled. */
export type MessageState = 'default' | 'pending' | 'failed'

function messageState(delivery: MessageDeliveryView | null): MessageState {
  if (!delivery) return 'default'
  if (delivery.state === 'failed') return 'failed'
  if (delivery.state === 'queued') return 'pending'
  if (delivery.state !== 'facts') return 'default'
  // Facts (ADR 0232): partial delivery stays default, its words say who was missed.
  const { state } = delivery.delivery
  if (state === 'failed' || state === 'denied') return 'failed'
  return state === 'sending' ? 'pending' : 'default'
}

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
  dateLocale,
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
    // Its chip is dropped while General shows only this Task; it still opens from here.
    ...(message.task_id && filtered && on.openTask
      ? [{ id: 'open-task', label: t('kubecode.task.openTask'), onSelect: on.openTask }]
      : []),
    ...(replies > 0 && on.openThread
      ? [{ id: 'thread', label: t('kubecode.channel.legacyThread.action'), onSelect: on.openThread }]
      : []),
  ]
  // While General shows only this Task, its chip would repeat under every message.
  const taskChip = task && !filtered && (
    <ReferenceChip kind="task" kindLabel={t('kubecode.vocab.object.task')} title={task.title} onOpen={on.openTask} />
  )
  const focusKey = `message:${message.id}`
  const ThreadIcon = WORKSPACE_OBJECT_ICONS.thread.Icon
  const own = message.author_kind === 'researcher'
  const time = date && (
    <time dateTime={date.toISOString()} title={date.toLocaleString(dateLocale)}>{shortTime(date, dateLocale)}</time>
  )
  // Whom it reached sits in the author line: "Investigate → General" (#229). The
  // researcher's own meta stays one line: the recipient is named, not described.
  const recipientClass = own ? 'min-w-0 overflow-hidden whitespace-nowrap' : undefined
  const recipientLine = recipients.kind !== 'none' && (
    <span className="kubecode-message-recipients inline-flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground">
      <span aria-hidden="true" className="text-muted-foreground" data-testid="recipients-arrow">→</span>
      <span className="sr-only">
        {recipients.kind === 'members' && recipients.handedOff ? t('kubecode.channel.handedOff') : t('kubecode.channel.to')}
      </span>
      {recipients.kind === 'members'
        ? recipients.members.map((member) => <Identity className={recipientClass} from={focusKey} key={member.key} size="sm" view={own ? nameOnly(member) : member} />)
        : recipients.manager
          ? <Identity className={recipientClass} from={focusKey} size="sm" view={own ? nameOnly(recipients.manager) : recipients.manager} />
          : <span>{t('kubecode.channel.toManager')}</span>}
    </span>
  )
  const state = messageState(delivery)
  return (
    // The official Message (ADR 0242): the researcher's own as the user's bubble on the right, members on the left.
    <ConversationMessage
      aria-label={author.name}
      data-author={message.author_kind}
      data-continued={continued}
      data-focus-key={focusKey}
      data-kind={message.kind}
      data-message-id={message.id}
      data-scroll-anchor={message.id}
      data-testid={`message-${message.seq}`}
      from={own ? 'self' : 'member'}
      id={`message-${message.id}`}
      state={state}
    >
      <div className="kubecode-message-header">
        {own ? (
          // The researcher's own message, on the right (ADR 0239): only the time shows.
          <span className="kubecode-message-author kubecode-message-self-meta">
            <span className="sr-only">{author.name}</span>
            {recipientLine}
            {time}
          </span>
        ) : (
          <>
            <Identity
              className="kubecode-message-author"
              from={focusKey}
              meta={time}
              size={continued ? 'sm' : 'md'}
              view={author}
            />
            {recipientLine}
          </>
        )}
        {message.intent !== 'say' && (
          <Badge variant="outline">
            {intentLabel(t, message.intent)}
            {message.intent_claimed_by ? ` · ${t('kubecode.channel.intent.claimed')}` : ''}
          </Badge>
        )}
        <MessageActions className="ml-auto opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100 data-[coarse=true]:opacity-100 pointer-coarse:opacity-100 motion-safe:transition-opacity group-data-[from=self]/message:order-first group-data-[from=self]/message:ml-0 group-data-[from=self]/message:mr-auto" data-coarse={coarse}>
          {!coarse && on.reply && (
            <MessageAction
              className="kubecode-message-action"
              label={t('kubecode.channel.replyTo', { author: author.name })}
              tooltip={t('kubecode.vocab.command.reply')}
              onClick={on.reply}
            >
              <Icon role="command" source={WORKSPACE_COMMAND_ICONS.reply.Icon} />
            </MessageAction>
          )}
          <MoreActions items={actions} label={t('kubecode.channel.messageActions', { author: author.name })} size={coarse ? 'md' : 'sm'} />
        </MessageActions>
      </div>
      <MessageContent className="kubecode-message-content">
        {cited && message.reply_to && (
          <Button
            className="h-auto max-w-full justify-start self-start px-0 text-muted-foreground"
            size="sm"
            type="button"
            variant="link"
            onClick={() => on.jump(message.reply_to as string)}
          >
            <Icon role="command" size="secondary" source={WORKSPACE_COMMAND_ICONS.reply.Icon} />
            <span className="truncate">
              {cited === 'missing'
                ? t('kubecode.channel.citationMissing')
                : t('kubecode.channel.citation', { author: cited.author.name, excerpt: cited.excerpt })}
            </span>
          </Button>
        )}
        {proposal && (
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">{t('kubecode.task.proposalBadge', { revision: Number(proposal[1]) })}</Badge>
            {message.task_id && onBoard && (
              <Badge data-on-board={onBoard(message.task_id)} variant={onBoard(message.task_id) ? 'secondary' : 'outline'}>
                {onBoard(message.task_id) ? t('kubecode.task.onBoard') : t('kubecode.task.notOnBoardYet')}
              </Badge>
            )}
          </div>
        )}
        <ConversationResponse className="kubecode-message-body" t={t}>{message.body}</ConversationResponse>
        {references.length > 0 ? (
          // Named, versioned, and resolved against the server (ADR 0231 §5), as Sources (ADR 0236).
          <ReferenceSources
            leading={taskChip}
            references={references}
            t={t}
            onOpen={on.openReference}
          />
        ) : taskChip && (
          <ul aria-label={t('kubecode.channel.references')} className="m-0 flex min-w-0 list-none flex-wrap gap-1 p-0">
            <li>{taskChip}</li>
          </ul>
        )}
        {replies > 0 && on.openThread && (
          <Button className="self-start px-0 text-muted-foreground" size="sm" variant="link" onClick={on.openThread}>
            <ThreadIcon aria-hidden="true" data-icon="inline-start" />
            {t('kubecode.channel.legacyThread.open', { count: replies, plural: replies === 1 ? 'y' : 'ies' })}
          </Button>
        )}
        {delivery?.state === 'facts' && (
          <DeliveryStatus
            body={message.body}
            delivery={delivery.delivery}
            latest={delivery.latest}
            locale={dateLocale}
            notes={delivery.notes}
            t={t}
          />
        )}
        {delivery?.state === 'failed' && (
          <Alert data-delivery="failed" variant="destructive">
            <AlertTitle>{t('kubecode.channel.notDelivered')}</AlertTitle>
            <AlertDescription>{delivery.text}</AlertDescription>
          </Alert>
        )}
        {(delivery?.state === 'queued' || delivery?.state === 'delivered') && (
          <p className="kubecode-message-delivery" data-delivery={delivery.state}>
            {deliveryText(delivery.state, delivery.recipients, dateLocale, t)}
          </p>
        )}
      </MessageContent>
    </ConversationMessage>
  )
}
