/**
 * The words for a delivery's state and for a refused retry (ADR 0232). Pure.
 */

import type { Translator } from '@/lib/i18n'

import { ApiError, type RouteDelivery } from '../api'

/** Who a route is for, by name; the project manager when the server names nobody. */
export function recipientName(route: RouteDelivery, t: Translator): string {
  return route.recipient?.name ?? t('kubecode.delivery.theManager')
}

/** Why a retry or reroute was refused, in words. */
export function retryRefusal(cause: unknown, name: string, t: Translator): string {
  if (cause instanceof ApiError) {
    if (cause.code === 'route_target_gone') return t('kubecode.delivery.targetGone', { name })
    if (cause.code === 'retry_limit') return t('kubecode.delivery.retryLimit')
    if (cause.code === 'route_not_retryable' || cause.code === 'message_not_reroutable') return t('kubecode.delivery.notRetryable')
  }
  return t('kubecode.delivery.retryFailed')
}

export function isTargetGone(cause: unknown): boolean {
  return cause instanceof ApiError && cause.code === 'route_target_gone'
}
