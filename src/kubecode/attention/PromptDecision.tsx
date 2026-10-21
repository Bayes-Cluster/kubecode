import { Loader2 } from 'lucide-react'
import { useId, type ReactNode } from 'react'

import { ConfirmationAction } from '@/components/ai-elements/confirmation'

const VARIANTS = { primary: 'default', secondary: 'outline' } as const

/**
 * One answer to a request (ADR 0242): the official `ConfirmationAction`,
 * which keeps focus and ignores clicks while the answer is recorded (ADR
 * 0227) and says why when it cannot be given yet.
 */
export function PromptDecision({ busy = false, children, disabledReason, onDecide, title, variant }: {
  children: ReactNode
  onDecide: () => void
  variant: 'primary' | 'secondary'
  busy?: boolean
  disabledReason?: string
  /** A longer description, such as the provider's own wording of the option. */
  title?: string
}) {
  const reasonId = useId()
  return (
    <>
      {disabledReason && <span className="sr-only" id={reasonId}>{disabledReason}</span>}
      <ConfirmationAction
        aria-busy={busy || undefined}
        aria-describedby={disabledReason ? reasonId : undefined}
        aria-disabled={busy || undefined}
        className="kubecode-decision-button"
        data-variant={variant}
        disabled={Boolean(disabledReason) && !busy}
        title={title}
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
      </ConfirmationAction>
    </>
  )
}
