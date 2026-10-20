import { createContext, useContext } from 'react'

/** Why a retry or reroute was refused, so the line can say what to do instead. */
export type DeliveryRefusal = 'gone' | 'limit' | 'notRetryable' | 'needsSetup' | 'failed'

/** What the researcher can do about a message's delivery (ADR 0232); provided by General. */
export type DeliveryActions = {
  /** Re-arms one failed route under its own id: never a second message. */
  retry(routeId: string, messageId: string): void
  /** Reads a message that reached nobody again, once setup is fixed. */
  reroute(messageId: string): void
  /** Route or message ids being retried or rerouted. */
  busy: ReadonlySet<string>
  refusals: ReadonlyMap<string, DeliveryRefusal>
  openMembers(): void
  /** Puts the message's text in the composer draft and focuses it. */
  copyToComposer(text: string): void
}

export const DeliveryActionsContext = createContext<DeliveryActions | null>(null)

export function useDeliveryActions(): DeliveryActions | null {
  return useContext(DeliveryActionsContext)
}
