import type { ChannelMessage, MessageDelivery } from '../api'

/**
 * What the browser says about a message's delivery (ADR 0229 §7). It says
 * only what it was told: a failure a note establishes, or — once the server's
 * delivery facts for the message are loaded (ADR 0232) — those facts, with
 * the routing notes they fold.
 */
export type MessageDeliveryView =
  | { state: 'failed'; text: string }
  | { state: 'queued' | 'delivered'; recipients: string[] }
  | { state: 'facts'; delivery: MessageDelivery; latest: boolean; notes: string[] }

export type MessageDeliverySource = (
  message: ChannelMessage,
  notes: readonly ChannelMessage[],
) => MessageDeliveryView | null

/** Failed when a "not delivered" note is about the message; otherwise nothing is claimed. */
export const notesDelivery: MessageDeliverySource = (_message, notes) => (
  notes.length > 0 ? { state: 'failed', text: notes[0].body } : null
)
