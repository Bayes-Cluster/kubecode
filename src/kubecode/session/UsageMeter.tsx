import { Gauge } from 'lucide-react'
import { Popover as PopoverPrimitive } from 'radix-ui'

import type { Translator } from '@/lib/i18n'

import { cn } from '@/lib/utils'

import { parseUsage, usageLevel } from './sessionModel'

type UsageMeterProps = {
  locale: string
  t: Translator
  usage: unknown
}

const LEVEL_CLASS: Record<string, string> = {
  ok: 'bg-[var(--accent-green)]',
  warning: 'bg-[var(--feedback-warning-border)]',
  danger: 'bg-[var(--accent-red)]',
}

function formatNumber(value: number, locale: string, compact = false): string {
  return new Intl.NumberFormat(locale, compact
    ? { notation: 'compact', maximumFractionDigits: 1 }
    : undefined).format(value)
}

/**
 * Live context-window meter (#106): the usage checkpoint the server already
 * pushes (`{ used, size, cost? }`) renders as a header gauge with threshold
 * colors and a counts-only fallback when the window size is unknown. It never
 * refetches — updates ride the session-state event stream.
 */
export function UsageMeter({ locale, t, usage }: UsageMeterProps) {
  const snapshot = parseUsage(usage)
  if (!snapshot || snapshot.used == null) return null
  const { used, size, cost } = snapshot
  const hasWindow = size != null && size > 0
  const percent = hasWindow ? Math.min(100, Math.round((used / (size as number)) * 100)) : null
  const level = hasWindow ? usageLevel(used, size as number) : 'ok'

  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger
        aria-label={t('kubecode.usageMeterOpen')}
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:bg-state-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="usage-meter-trigger"
        title={t('kubecode.usageMeterOpen')}
      >
        <Gauge aria-hidden className="h-3.5 w-3.5" />
        <span data-testid="usage-meter-value">
          {hasWindow ? `${percent}%` : formatNumber(used, locale, true)}
        </span>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          className="z-50 w-64 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md"
          data-testid="usage-meter-popover"
          sideOffset={6}
        >
          <p className="text-xs font-medium text-text-secondary">{t('kubecode.usageContextTitle')}</p>
          {hasWindow ? (
            <>
              <div
                aria-hidden
                className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted"
              >
                <div
                  className={cn('h-full rounded-full transition-[width]', LEVEL_CLASS[level])}
                  data-testid="usage-meter-bar"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <p className="mt-2 text-sm" data-testid="usage-meter-detail">
                {t('kubecode.usageOfWindow', {
                  percent: percent as number,
                  total: formatNumber(size as number, locale),
                  used: formatNumber(used, locale),
                })}
              </p>
            </>
          ) : (
            <p className="mt-2 text-sm" data-testid="usage-meter-detail">
              {t('kubecode.usageTokensOnly', { count: formatNumber(used, locale) })}
            </p>
          )}
          {cost && (
            <p className="mt-1 text-xs text-text-muted">
              {t('kubecode.usageCost', { cost })}
            </p>
          )}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
