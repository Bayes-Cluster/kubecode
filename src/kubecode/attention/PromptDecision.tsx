import { useId, type ReactNode } from 'react'

import { ConfirmationAction } from '@/components/ai-elements/confirmation'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Spinner } from '@/components/ui/spinner'
import type { Translator } from '@/lib/i18n'

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
        {busy && <Spinner aria-hidden aria-label={undefined} className="motion-reduce:animate-none" data-icon="inline-start" role={undefined} />}
        {children}
      </ConfirmationAction>
    </>
  )
}

/**
 * What happened to an answer, shared by every prompt (#259): recorded and
 * waiting (a polite status), refused (an official destructive Alert, heard at
 * once), or no longer waiting because it was answered elsewhere.
 */
export function PromptOutcome({ outcome, resolving, t }: {
  outcome: 'failed' | 'gone' | null
  resolving: boolean
  t: Translator
}) {
  return (
    <>
      {resolving && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Spinner aria-hidden aria-label={undefined} className="motion-reduce:animate-none" role={undefined} />
          {t('kubecode.attention.resolving')}
        </p>
      )}
      {outcome === 'failed' && (
        <Alert variant="destructive">
          <AlertDescription>{t('kubecode.attention.resolveFailed')}</AlertDescription>
        </Alert>
      )}
      {outcome === 'gone' && <p className="text-sm text-muted-foreground" role="status">{t('kubecode.attention.answeredElsewhere')}</p>}
    </>
  )
}
