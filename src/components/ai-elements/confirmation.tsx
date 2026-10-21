/**
 * Adapted from AI Elements `confirmation`
 * (https://ui.shadcn.com/docs/ai-elements/components/confirmation,
 * registry https://registry.ai-sdk.dev/confirmation.json, ai-elements 1.9.1).
 *
 * Adaptations (ADR 0233): presents a pending decision from the server
 * projection (ADR 0232) rather than an `ai` SDK tool approval, so its states
 * are `requested`, `approved`, `rejected`; it is a labelled group instead of
 * an `alert` (it does not interrupt the reader); actions are Workspace
 * `DecisionButton`s supplied by the caller. A mention or a message never
 * stands in for this decision.
 */
import { createContext, useContext, useId, type ComponentProps, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

export type ConfirmationState = 'requested' | 'approved' | 'rejected'

const ConfirmationContext = createContext<{ state: ConfirmationState; titleId: string } | null>(null)

function useConfirmation() {
  const context = useContext(ConfirmationContext)
  if (!context) throw new Error('Confirmation parts must be used within Confirmation')
  return context
}

export function Confirmation({ className, state, ...props }: ComponentProps<'section'> & { state: ConfirmationState }) {
  const titleId = useId()
  return (
    <ConfirmationContext.Provider value={{ state, titleId }}>
      <section aria-labelledby={titleId} className={cn('kubecode-ai-confirmation', className)} data-state={state} {...props} />
    </ConfirmationContext.Provider>
  )
}

export function ConfirmationTitle({ className, ...props }: ComponentProps<'h3'>) {
  const { titleId } = useConfirmation()
  return <h3 className={cn('kubecode-ai-confirmation-title', className)} id={titleId} {...props} />
}

function Only({ children, when }: { children?: ReactNode; when: ConfirmationState }) {
  return useConfirmation().state === when ? <>{children}</> : null
}

export const ConfirmationRequest = ({ children }: { children?: ReactNode }) => <Only when="requested">{children}</Only>
export const ConfirmationAccepted = ({ children }: { children?: ReactNode }) => <Only when="approved">{children}</Only>
export const ConfirmationRejected = ({ children }: { children?: ReactNode }) => <Only when="rejected">{children}</Only>

export function ConfirmationActions({ className, ...props }: ComponentProps<'div'>) {
  const { state } = useConfirmation()
  if (state !== 'requested') return null
  return <div className={cn('kubecode-ai-confirmation-actions', className)} {...props} />
}
