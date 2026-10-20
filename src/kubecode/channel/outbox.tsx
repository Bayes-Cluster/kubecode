import { useCallback } from 'react'

import { Button } from '@/components/ui/button'
import type { Translator } from '@/lib/i18n'

import { usePlaceState } from '../app/location/placeMemory'
import { excerptOf } from './generalDraft'

/**
 * A send the server has not acknowledged yet (ADR 0232 §5): its own row,
 * apart from the draft, under the client message id it was first sent with.
 * Sending it again replays that id, so a save that committed but whose answer
 * was lost is never posted twice; and nothing typed since is ever merged into
 * it or overwritten by it.
 */
export type OutboxItem<P> = {
  id: string
  /** What the row shows. */
  text: string
  /** What is sent again: the message, and for General the draft it came from. */
  payload: P
  state: 'sending' | 'failed'
  failure: string | null
}

export type Outbox<P> = {
  items: OutboxItem<P>[]
  /**
   * Sends under `id`: the row says "Sending…" until the server has it, then
   * goes; on failure it stays, "Not sent", with the reason `reason` gives.
   */
  send(item: Pick<OutboxItem<P>, 'id' | 'text' | 'payload'>, call: () => Promise<unknown>, reason: (cause: unknown) => string): Promise<boolean>
  discard(id: string): void
}

/** One place's unsent messages, kept in memory for the life of the page (never on disk). */
export function useOutbox<P>(key: string | null): Outbox<P> {
  const [items, setItems] = usePlaceState<OutboxItem<P>[]>(key, [])
  const send = useCallback<Outbox<P>['send']>(async (item, call, reason) => {
    setItems((current) => [
      ...current.filter((existing) => existing.id !== item.id),
      { ...item, state: 'sending', failure: null },
    ])
    try {
      await call()
      setItems((current) => current.filter((existing) => existing.id !== item.id))
      return true
    } catch (cause) {
      const failure = reason(cause)
      setItems((current) => current.map((existing) => (
        existing.id === item.id ? { ...existing, state: 'failed', failure } : existing
      )))
      return false
    }
  }, [setItems])
  const discard = useCallback((id: string) => {
    setItems((current) => current.filter((existing) => existing.id !== id))
  }, [setItems])
  return { items, send, discard }
}

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
