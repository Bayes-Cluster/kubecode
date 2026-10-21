/**
 * Adapted from AI Elements `chain-of-thought`
 * (https://ui.shadcn.com/docs/ai-elements/components/chain-of-thought,
 * registry https://registry.ai-sdk.dev/chain-of-thought.json, ai-elements 1.9.1).
 *
 * Adaptations (ADR 0233): used for a member's recorded activity steps, never
 * for private model reasoning; `@radix-ui/react-use-controllable-state` is
 * dropped for Radix Collapsible's own controlled/uncontrolled state; a step's
 * status is said in words (`statusLabel`), not only by its dot; search-result
 * badges and images are left out.
 */
import type { ComponentProps, ReactNode } from 'react'

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS } from '@/kubecode/icons/workspaceIcons'
import { cn } from '@/lib/utils'

export function ChainOfThought({ className, ...props }: ComponentProps<typeof Collapsible>) {
  return <Collapsible className={cn('kubecode-ai-chain', className)} {...props} />
}

export function ChainOfThoughtHeader({ children, className, ...props }: ComponentProps<typeof CollapsibleTrigger>) {
  return (
    <CollapsibleTrigger className={cn('kubecode-ai-disclosure', className)} {...props}>
      <span>{children}</span>
      <Icon className="kubecode-ai-disclosure-chevron" role="control" source={WORKSPACE_COMMAND_ICONS.expand.Icon} />
    </CollapsibleTrigger>
  )
}

export function ChainOfThoughtContent({ children, className, ...props }: ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent className={cn('kubecode-ai-chain-content', className)} {...props}>
      <ol className="kubecode-ai-chain-steps">{children}</ol>
    </CollapsibleContent>
  )
}

export type ChainOfThoughtStepStatus = 'complete' | 'active' | 'pending' | 'failed'

export type ChainOfThoughtStepProps = Omit<ComponentProps<'li'>, 'children'> & {
  label: ReactNode
  description?: ReactNode
  status: ChainOfThoughtStepStatus
  /** The status in words, for example "Running". */
  statusLabel: string
  children?: ReactNode
}

export function ChainOfThoughtStep({ children, className, description, label, status, statusLabel, ...props }: ChainOfThoughtStepProps) {
  return (
    <li className={cn('kubecode-ai-chain-step', className)} data-status={status} {...props}>
      <span aria-hidden="true" className="kubecode-ai-chain-dot" />
      <div className="kubecode-ai-chain-body">
        <p className="kubecode-ai-chain-label">
          {label}
          <span className="kubecode-ai-chain-status">{statusLabel}</span>
        </p>
        {description && <p className="kubecode-ai-chain-description">{description}</p>}
        {children}
      </div>
    </li>
  )
}
