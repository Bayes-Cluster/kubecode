import { useRef, useState } from 'react'
import { Gauge } from 'lucide-react'

import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextTrigger,
} from '@/components/ai-elements/context'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import type { Translator } from '@/lib/i18n'

import { parseUsage, usageLevel } from './sessionModel'

type UsageMeterProps = {
  locale: string
  t: Translator
  usage: unknown
}

function formatNumber(value: number, locale: string, compact = false): string {
  return new Intl.NumberFormat(locale, compact
    ? { notation: 'compact', maximumFractionDigits: 1 }
    : undefined).format(value)
}

/**
 * Live context-window meter (#106) on the official Context element
 * (ADR 0245): the usage checkpoint the server already pushes
 * (`{ used, size, cost? }`) renders as a header gauge with threshold colors
 * and a counts-only fallback when the window size is unknown. Every label
 * and number is localized here, so none of the element's English defaults
 * show. It opens on click like the header's other popovers, never on hover,
 * and it never refetches — updates ride the session-state event stream.
 */
export function UsageMeter({ locale, t, usage }: UsageMeterProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const snapshot = parseUsage(usage)
  if (!snapshot || snapshot.used == null) return null
  const { used, size, cost } = snapshot
  const hasWindow = size != null && size > 0
  const percent = hasWindow ? Math.min(100, Math.round((used / (size as number)) * 100)) : null
  const level = hasWindow ? usageLevel(used, size as number) : 'ok'
  const openLabel = t('kubecode.usageMeterOpen')

  return (
    <Context
      maxTokens={hasWindow ? (size as number) : used}
      open={open}
      usedTokens={used}
      // The element is a hover card: it asks to close whenever the pointer
      // or focus leaves the trigger. Those requests are ignored so the
      // meter behaves like a popover — a click toggles it, and only an
      // explicit dismissal (Escape, a press outside) closes it.
      onOpenChange={() => {}}
    >
      <ContextTrigger>
        <Button
          aria-expanded={open}
          aria-label={openLabel}
          className="kubecode-session-usage-trigger"
          data-level={level}
          data-testid="usage-meter-trigger"
          data-ws-components="official"
          size="sm"
          title={openLabel}
          type="button"
          variant="outline"
          ref={triggerRef}
          onClick={() => setOpen((current) => !current)}
        >
          <Gauge aria-hidden size={14} />
          <span data-testid="usage-meter-value">
            {hasWindow ? `${percent}%` : formatNumber(used, locale, true)}
          </span>
        </Button>
      </ContextTrigger>
      <ContextContent
        align="end"
        className="kubecode-session-usage"
        data-testid="usage-meter-popover"
        data-ws-components="official"
        sideOffset={6}
        onEscapeKeyDown={() => setOpen(false)}
        // The trigger toggles; a press on it is not a dismissal.
        onPointerDownOutside={(event) => {
          if (triggerRef.current?.contains(event.target as Node)) event.preventDefault()
          else setOpen(false)
        }}
      >
        <ContextContentHeader>
          <p className="text-xs font-medium text-muted-foreground">{t('kubecode.usageContextTitle')}</p>
          {hasWindow && (
            <Progress
              aria-label={t('kubecode.usageContextTitle')}
              // shadcn's Progress paints the value without handing it to
              // the Radix root, so the value is named here for readers.
              aria-valuenow={percent as number}
              className="kubecode-session-usage-bar"
              data-level={level}
              data-testid="usage-meter-bar"
              value={percent}
            />
          )}
        </ContextContentHeader>
        <ContextContentBody>
          <p className="text-sm" data-testid="usage-meter-detail">
            {hasWindow
              ? t('kubecode.usageOfWindow', {
                percent: percent as number,
                total: formatNumber(size as number, locale),
                used: formatNumber(used, locale),
              })
              : t('kubecode.usageTokensOnly', { count: formatNumber(used, locale) })}
          </p>
        </ContextContentBody>
        {cost && (
          <ContextContentFooter>
            <p className="text-xs text-muted-foreground">{t('kubecode.usageCost', { cost })}</p>
          </ContextContentFooter>
        )}
      </ContextContent>
    </Context>
  )
}
