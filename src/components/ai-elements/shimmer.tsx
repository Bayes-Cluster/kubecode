/**
 * Adapted from AI Elements `shimmer`
 * (https://ui.shadcn.com/docs/ai-elements/components/shimmer,
 * registry https://registry.ai-sdk.dev/shimmer.json, ai-elements 1.9.1).
 *
 * Adaptations (ADR 0233): a CSS gradient animation replaces `motion` (no new
 * dependency) and is still text under reduced motion.
 */
import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

export function Shimmer({ className, ...props }: ComponentProps<'span'>) {
  return <span className={cn('kubecode-ai-shimmer', className)} {...props} />
}
