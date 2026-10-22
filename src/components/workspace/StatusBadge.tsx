import type { ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'

/** How a status reads at a glance. Colors come from semantic tokens, never from the view. */
export type StatusTone = 'ok' | 'info' | 'warn' | 'danger' | 'muted'

const VARIANT = {
  ok: 'success',
  info: 'info',
  warn: 'warning',
  danger: 'destructive',
  muted: 'secondary',
} as const satisfies Record<StatusTone, string>

export type StatusBadgeProps = {
  children: ReactNode
  className?: string
  tone?: StatusTone
  /** Names the status for assistive technology when the text alone is not enough. */
  title?: string
}

/**
 * One status label for every Workspace view (a Task stage, a member's setup
 * state, a source's availability), on the official Badge (ADR 0247). The text
 * always carries the meaning; the tone only picks a Badge variant, so it is
 * never the only signal.
 */
export function StatusBadge({ children, className, title, tone = 'muted' }: StatusBadgeProps) {
  return (
    <Badge className={className} data-tone={tone} title={title} variant={VARIANT[tone]}>
      {children}
    </Badge>
  )
}
