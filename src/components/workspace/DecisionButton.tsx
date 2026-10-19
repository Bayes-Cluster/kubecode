import { Loader2 } from 'lucide-react'
import { useId, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
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
        {busy && <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" size={14} />}
        {children}
      </Button>
      {disabledReason && <span className="kubecode-decision-reason" id={reasonId}>{disabledReason}</span>}
    </span>
  )
}
