import { useId, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'

export type DecisionButtonProps = {
  /** The decision in words, for example "Accept results". Never an icon alone. */
  children: ReactNode
  onDecide: () => void
  /** `primary` for the decision the view leads to, `destructive` for one that discards. */
  variant?: 'primary' | 'secondary' | 'destructive'
  /** The decision is being recorded: it keeps focus, ignores clicks, and says so. */
  busy?: boolean
  /** Why the decision cannot be made now; the button is disabled and says why. */
  disabledReason?: string
  className?: string
  testId?: string
  /** A longer description, such as the provider's own wording of an option. */
  title?: string
}

const VARIANTS = { primary: 'default', secondary: 'outline', destructive: 'destructive' } as const

/**
 * A research decision — add to the board, accept results, send back, accept a
 * version (ADR 0227). It is always text-labelled, wraps a long translation,
 * and when it cannot be made it says why instead of only greying out.
 */
export function DecisionButton({
  busy = false,
  children,
  className,
  disabledReason,
  onDecide,
  testId,
  title,
  variant = 'secondary',
}: DecisionButtonProps) {
  const reasonId = useId()
  return (
    <span className="kubecode-decision">
      <Button
        aria-busy={busy || undefined}
        aria-describedby={disabledReason ? reasonId : undefined}
        aria-disabled={busy || undefined}
        className={cn('kubecode-decision-button', className)}
        data-testid={testId}
        data-variant={variant}
        disabled={Boolean(disabledReason) && !busy}
        size="sm"
        title={title}
        type="button"
        variant={VARIANTS[variant]}
        onClick={(event) => {
          if (busy) {
            event.preventDefault()
            return
          }
          onDecide()
        }}
      >
        {busy && <Spinner aria-hidden aria-label={undefined} className="motion-reduce:animate-none" data-icon="inline-start" role={undefined} />}
        {children}
      </Button>
      {disabledReason && <span className="kubecode-decision-reason" id={reasonId}>{disabledReason}</span>}
    </span>
  )
}
