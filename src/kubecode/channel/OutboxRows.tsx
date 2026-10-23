import { Message, MessageAction, MessageActions, MessageContent } from '@/components/ai-elements/message'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Spinner } from '@/components/ui/spinner'
import type { Translator } from '@/lib/i18n'

import { excerptOf } from './generalDraft'
import type { OutboxItem } from './outbox'

/**
 * The rows of a place's unsent messages, each the researcher's own Message in
 * its pending state (ADR 0242): "Sending…", or "Not sent: why" with Send
 * again (the same message, never a second one), Edit (back into the
 * composer, offered only while it is empty) and Discard.
 */
export function OutboxRows<P>({ items, onDiscard, onEdit, onSendAgain, t }: {
  items: OutboxItem<P>[]
  onSendAgain: (item: OutboxItem<P>) => void
  onDiscard: (item: OutboxItem<P>) => void
  /** Puts the words back in the composer; absent while the composer holds other words it would overwrite. */
  onEdit?: (item: OutboxItem<P>) => void
  t: Translator
}) {
  if (items.length === 0) return null
  return (
    <ul aria-label={t('kubecode.outbox.label')} className="m-0 flex list-none flex-col gap-1 p-0">
      {items.map((item) => (
        <li className="flex flex-col gap-1" data-client-message-id={item.id} data-state={item.state} key={item.id}>
          <Message className="max-w-none" data-state={item.state === 'sending' ? 'pending' : 'failed'} from="user">
            <MessageContent>
              <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{excerptOf(item.text, 200)}</span>
              {item.state === 'sending'
                ? (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Spinner aria-hidden="true" />
                    {t('kubecode.outbox.sending')}
                  </span>
                )
                : (
                  <Alert variant="destructive">
                    <AlertDescription>{t('kubecode.outbox.notSent', { reason: item.failure ?? t('kubecode.error') })}</AlertDescription>
                  </Alert>
                )}
            </MessageContent>
            {item.state !== 'sending' && (
              <MessageActions className="flex-wrap">
                <MessageAction size="sm" variant="outline" onClick={() => onSendAgain(item)}>{t('kubecode.outbox.sendAgain')}</MessageAction>
                {onEdit && <MessageAction size="sm" onClick={() => onEdit(item)}>{t('kubecode.outbox.edit')}</MessageAction>}
                <MessageAction size="sm" onClick={() => onDiscard(item)}>{t('kubecode.outbox.discard')}</MessageAction>
              </MessageActions>
            )}
          </Message>
        </li>
      ))}
    </ul>
  )
}
