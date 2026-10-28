import { useRef, type ReactNode } from 'react'

import { Confirmation } from '@/components/ai-elements/confirmation'

import { useFocusHandoff } from './decisionFocus'

/**
 * ADR 0257, slice D: the shared decision-card scaffolding every prompt
 * composes — the official Confirmation engine, the focus handoff (its hooks
 * live in `decisionFocus.ts`), and the resolving/failure/gone outcome
 * line's home in the caller.
 */

export interface DecisionCardProps {
  /** Names the card and the request for assistive technology. */
  label: string
  /** The attention identity the snapshot removes; focus keys hang off it. */
  attentionKey: string
  focusKeyPrefix: string
  /** The card root's test id, for the suites. */
  testId?: string
  /** The card's keyboard contract (e.g. digit answers), on the root. */
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>
  children: ReactNode
  className?: string
}

export function DecisionCard({ attentionKey, children, className, focusKeyPrefix, label, onKeyDown, testId }: DecisionCardProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  useFocusHandoff(rootRef, focusKeyPrefix)
  return (
    <Confirmation
      approval={{ id: attentionKey }}
      aria-label={label}
      className={className}
      data-focus-key={`${focusKeyPrefix}:${attentionKey}`}
      data-testid={testId}
      onKeyDown={onKeyDown}
      role="group"
      state="approval-requested"
      tabIndex={0}
      ref={rootRef}
    >
      {children}
    </Confirmation>
  )
}
