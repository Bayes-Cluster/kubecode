import { Button } from '@/components/ui/button'
import type { Translator } from '@/lib/i18n'

import { excerptOf } from './generalDraft'
import type { OutboxItem } from './outbox'

/**
 * The rows of a place's unsent messages: "Sending…", or "Not sent: why" with
 * Send again (the same message, never a second one), Edit (back into the
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
    <ul aria-label={t('kubecode.outbox.label')} className="kubecode-outbox">
      {items.map((item) => (
        <li className="kubecode-outbox-row" data-client-message-id={item.id} data-state={item.state} key={item.id}>
          <span className="kubecode-outbox-text">{excerptOf(item.text, 200)}</span>
          {item.state === 'sending'
            ? <span className="kubecode-research-muted">{t('kubecode.outbox.sending')}</span>
            : (
              <span className="kubecode-outbox-failure" role="alert">
                <span className="kubecode-research-error">{t('kubecode.outbox.notSent', { reason: item.failure ?? t('kubecode.error') })}</span>
                <Button size="xs" variant="outline" onClick={() => onSendAgain(item)}>{t('kubecode.outbox.sendAgain')}</Button>
                {onEdit && <Button size="xs" variant="ghost" onClick={() => onEdit(item)}>{t('kubecode.outbox.edit')}</Button>}
                <Button size="xs" variant="ghost" onClick={() => onDiscard(item)}>{t('kubecode.outbox.discard')}</Button>
              </span>
            )}
        </li>
      ))}
    </ul>
  )
}
