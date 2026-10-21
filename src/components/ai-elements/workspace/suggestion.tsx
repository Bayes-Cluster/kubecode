/**
 * Adapted from AI Elements `suggestion`
 * (https://ui.shadcn.com/docs/ai-elements/components/suggestion,
 * registry https://registry.ai-sdk.dev/suggestion.json, ai-elements 1.9.1).
 *
 * Adaptations (ADR 0233): suggestions wrap instead of scrolling sideways
 * (no `scroll-area`), form a labelled group, and only fill the draft — a
 * suggestion never sends or authorizes anything.
 */
import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

export function Suggestions({ className, label, ...props }: ComponentProps<'div'> & { label: string }) {
  return <div aria-label={label} className={cn('kubecode-ai-suggestions', className)} role="group" {...props} />
}

export type SuggestionProps = Omit<ComponentProps<'button'>, 'onClick'> & {
  suggestion: string
  onClick?: (suggestion: string) => void
}

export function Suggestion({ children, className, onClick, suggestion, ...props }: SuggestionProps) {
  return (
    <button className={cn('kubecode-ai-suggestion', className)} type="button" onClick={() => onClick?.(suggestion)} {...props}>
      {children ?? suggestion}
    </button>
  )
}
