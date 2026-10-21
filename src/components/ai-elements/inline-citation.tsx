/**
 * Adapted from AI Elements `inline-citation`
 * (https://ui.shadcn.com/docs/ai-elements/components/inline-citation,
 * registry https://registry.ai-sdk.dev/inline-citation.json, ai-elements 1.9.1).
 *
 * Adaptations (ADR 0233): the hover card becomes a Radix popover opened by a
 * real button, so keyboard and touch readers reach it; the trigger shows the
 * citation number, not a URL hostname, because a Workspace citation points at
 * a Workspace object (a file, evidence, a finding) shown as a
 * `ReferenceChip`; the carousel is replaced by a list (no `embla` dependency).
 */
import type { ComponentProps } from 'react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export function InlineCitation({ className, ...props }: ComponentProps<'span'>) {
  return <span className={cn('kubecode-ai-citation', className)} {...props} />
}

export function InlineCitationText({ className, ...props }: ComponentProps<'span'>) {
  return <span className={cn('kubecode-ai-citation-text', className)} {...props} />
}

export const InlineCitationCard = Popover

export type InlineCitationCardTriggerProps = Omit<ComponentProps<'button'>, 'children'> & {
  /** What is shown, for example "1" or "1–2". */
  index: string
  /** The accessible name, for example "Source 1: Related work notes". */
  label: string
}

export function InlineCitationCardTrigger({ className, index, label, ...props }: InlineCitationCardTriggerProps) {
  return (
    <PopoverTrigger asChild>
      <button aria-label={label} className={cn('kubecode-ai-citation-trigger', className)} type="button" {...props}>
        <span aria-hidden="true">{index}</span>
      </button>
    </PopoverTrigger>
  )
}

export function InlineCitationCardBody({ className, ...props }: ComponentProps<typeof PopoverContent>) {
  return <PopoverContent className={cn('kubecode-ai-citation-card', className)} {...props} />
}

export function InlineCitationSource({ children, className, description, ...props }: ComponentProps<'div'> & { description?: string }) {
  return (
    <div className={cn('kubecode-ai-citation-source', className)} {...props}>
      {children}
      {description && <p className="kubecode-ai-citation-description">{description}</p>}
    </div>
  )
}

export function InlineCitationQuote({ className, ...props }: ComponentProps<'blockquote'>) {
  return <blockquote className={cn('kubecode-ai-citation-quote', className)} {...props} />
}
