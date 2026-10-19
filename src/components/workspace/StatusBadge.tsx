import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/** How a status reads at a glance. Colors come from semantic tokens, never from the view. */
export type StatusTone = 'ok' | 'info' | 'warn' | 'danger' | 'muted'

export type StatusBadgeProps = {
  children: ReactNode
  className?: string
  tone?: StatusTone
  /** Names the status for assistive technology when the text alone is not enough. */
  title?: string
}

/**
 * One status label for every Workspace view (a Task stage, a member's setup
 * state, a source's availability). The text always carries the meaning; the
 * tone only adds emphasis, so it is never the only signal.
 */
export function StatusBadge({ children, className, title, tone = 'muted' }: StatusBadgeProps) {
  return (
    <span
      className={cn('kubecode-research-badge', className)}
      data-tone={tone}
      title={title}
    >
      {children}
    </span>
  )
}
