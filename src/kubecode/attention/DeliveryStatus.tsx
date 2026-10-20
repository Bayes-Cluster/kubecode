import { Button } from '@/components/ui/button'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS } from '@/kubecode/icons/workspaceIcons'
import type { TranslationKey, Translator } from '@/lib/i18n'

import type { MessageDelivery, RouteDelivery } from '../api'
import { useDeliveryActions, type DeliveryRefusal } from './deliveryContext'
import { recipientName, retryingText } from './deliveryWords'

export type DeliveryStatusProps = {
  delivery: MessageDelivery
  /** The researcher's latest message: the only one that says "Delivered". */
  latest: boolean
  /** The message's text, for "Copy to message box". */
  body: string
  /** Routing notes folded into this message, shown under Details. */
  notes: string[]
  /** The app language's list and date locale. */
  locale?: string
  t: Translator
}

const DENIALS: Record<string, TranslationKey> = {
  manager_unavailable: 'kubecode.delivery.denied.manager_unavailable',
  member_unavailable: 'kubecode.delivery.denied.member_unavailable',
  dm_private: 'kubecode.delivery.denied.dm_private',
  request_refused: 'kubecode.delivery.denied.request_refused',
}

function names(routes: RouteDelivery[], locale: string, t: Translator): string {
  const unique = [...new Set(routes.map((route) => recipientName(route, t)))]
  return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(unique)
}

function FailedRoute({ body, messageId, route, t }: { body: string; messageId: string; route: RouteDelivery; t: Translator }) {
  const actions = useDeliveryActions()
  const name = recipientName(route, t)
  const refusal = actions?.refusals.get(route.route_id)
  const busy = actions?.busy.has(route.route_id) ?? false
  return (
    <div className="kubecode-delivery-failure">
      <span className="kubecode-research-error" role="status">{t('kubecode.delivery.failed', { name })}</span>
      {route.retryable && actions && refusal !== 'gone' && refusal !== 'limit' && (
        <Button
          aria-busy={busy || undefined}
          size="xs"
          variant="ghost"
          onClick={() => { if (!busy) actions.retry(route.route_id, messageId) }}
        >
          <Icon role="command" size="secondary" source={WORKSPACE_COMMAND_ICONS.retry.Icon} />
          {t('kubecode.delivery.retry', { name })}
        </Button>
      )}
      {refusal === 'gone' && (
        <>
          <span>{t('kubecode.delivery.targetGone', { name })}</span>
          {actions && (
            <Button size="xs" variant="ghost" onClick={() => actions.copyToComposer(body)}>
              {t('kubecode.delivery.copyToComposer')}
            </Button>
          )}
        </>
      )}
      {refusal === 'limit' && <span>{t('kubecode.delivery.retryLimit')}</span>}
      {refusal === 'needsSetup' && (
        <>
          <span>{t('kubecode.delivery.needsSetup', { name })}</span>
          {actions && <Button size="xs" variant="ghost" onClick={actions.openMembers}>{t('kubecode.delivery.openMembers')}</Button>}
        </>
      )}
      {refusal === 'notRetryable' && <span>{t('kubecode.delivery.notRetryable')}</span>}
      {refusal === 'failed' && <span role="alert">{t('kubecode.delivery.retryFailed')}</span>}
    </div>
  )
}

/** Why Try again did not work: refused by the server, or never reached it. */
function RerouteRefusal({ refusal, t }: { refusal: DeliveryRefusal | undefined; t: Translator }) {
  if (!refusal) return null
  if (refusal === 'failed') return <span className="kubecode-research-error" role="alert">{t('kubecode.delivery.retryFailed')}</span>
  return <span>{t('kubecode.delivery.notRetryable')}</span>
}

/**
 * A researcher message's delivery, from facts only (ADR 0232): saved,
 * sending, busy or still retrying, queued, delivered (on the latest message
 * only), removed from a queue, not delivered — by recipient, with Retry — or
 * reaching nobody, with why and a way to fix it. The routing notes it folds
 * are under Details.
 */
export function DeliveryStatus({ body, delivery, latest, locale = 'en', notes, t }: DeliveryStatusProps) {
  const actions = useDeliveryActions()
  const { routes } = delivery
  const lines: Array<{ key: string; text: string; title?: string }> = []
  const by = (state: RouteDelivery['state']) => routes.filter((route) => route.state === state)

  if (delivery.state === 'saved') lines.push({ key: 'saved', text: t('kubecode.delivery.saved') })
  if (delivery.state === 'recorded' && latest) lines.push({ key: 'recorded', text: t('kubecode.delivery.recorded') })
  for (const route of by('busy')) {
    lines.push({ key: route.route_id, text: t('kubecode.delivery.busy', { name: recipientName(route, t) }) })
  }
  for (const route of by('retrying')) {
    lines.push({ key: route.route_id, text: retryingText(route, t) })
  }
  if (by('sending').length > 0) lines.push({ key: 'sending', text: t('kubecode.delivery.sending', { names: names(by('sending'), locale, t) }) })
  for (const route of by('queued')) {
    lines.push({ key: route.route_id, text: t('kubecode.delivery.queued', { name: recipientName(route, t) }) })
  }
  for (const route of by('withdrawn')) {
    lines.push({ key: route.route_id, text: t('kubecode.delivery.withdrawn', { name: recipientName(route, t) }) })
  }
  if (latest && by('started').length > 0) {
    lines.push({
      key: 'delivered',
      text: t('kubecode.delivery.delivered', { names: names(by('started'), locale, t) }),
      title: t('kubecode.delivery.deliveredHint'),
    })
  }
  const failed = by('failed')
  const denial = delivery.state === 'denied' || (delivery.state === 'partial' && delivery.denial) ? delivery.denial : null
  const details = [...failed.map((route) => route.last_error).filter((text): text is string => Boolean(text)), ...notes]
  if (lines.length === 0 && failed.length === 0 && !denial) return null

  return (
    <div className="kubecode-delivery-status" data-focus-key={`delivery:${delivery.message_id}`} data-state={delivery.state}>
      {lines.map((line) => (
        <p className="kubecode-message-delivery" key={line.key} title={line.title}>{line.text}</p>
      ))}
      {failed.map((route) => (
        <FailedRoute body={body} key={route.route_id} messageId={delivery.message_id} route={route} t={t} />
      ))}
      {denial && (
        <div className="kubecode-delivery-failure">
          <span className="kubecode-research-error" role="status">
            {t(DENIALS[denial.code] ?? 'kubecode.delivery.denied.other')}
          </span>
          {actions && (
            <>
              <Button size="xs" variant="ghost" onClick={actions.openMembers}>{t('kubecode.delivery.openMembers')}</Button>
              {denial.reroutable && (
                <Button
                  aria-busy={actions.busy.has(delivery.message_id) || undefined}
                  size="xs"
                  variant="ghost"
                  onClick={() => { if (!actions.busy.has(delivery.message_id)) actions.reroute(delivery.message_id) }}
                >
                  {t('kubecode.delivery.reroute')}
                </Button>
              )}
            </>
          )}
          <RerouteRefusal refusal={actions?.refusals.get(delivery.message_id)} t={t} />
        </div>
      )}
      {details.length > 0 && (
        <details className="kubecode-delivery-details">
          <summary>{t('kubecode.delivery.details')}</summary>
          <ul>{details.map((text, index) => <li key={index}>{text}</li>)}</ul>
        </details>
      )}
    </div>
  )
}
