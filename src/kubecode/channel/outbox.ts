import { useCallback } from 'react'

import { usePlaceState } from '../app/location/placeMemory'

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
