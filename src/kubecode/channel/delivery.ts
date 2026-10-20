import type { ChannelMessage } from '../api'

/**
 * What the browser says about a message's delivery (ADR 0229 §7). It says
 * only what it was told: a failure a note establishes. Per-route delivery
 * facts are a later source (#220) behind the same seam.
 */
export type MessageDeliveryView =
  | { state: 'failed'; text: string }
  | { state: 'queued' | 'delivered'; recipients: string[] }

export type MessageDeliverySource = (
  message: ChannelMessage,
  notes: readonly ChannelMessage[],
) => MessageDeliveryView | null

/** Failed when a "not delivered" note is about the message; otherwise nothing is claimed. */
export const notesDelivery: MessageDeliverySource = (_message, notes) => (
  notes.length > 0 ? { state: 'failed', text: notes[0].body } : null
)
