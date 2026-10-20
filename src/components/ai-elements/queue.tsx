/**
 * Adapted from AI Elements `queue`
 * (https://ui.shadcn.com/docs/ai-elements/components/queue,
 * registry https://registry.ai-sdk.dev/queue.json, ai-elements 1.9.1).
 *
 * Adaptations (ADR 0233): the scroll area is a focusable native scroller (no
 * `scroll-area` component); the section label is one caller string with its
 * count already formatted for plurals; an item's state is said in words, not
 * only by strike-through; per-item remove/edit actions and attachment
 * previews are left out because the queue is a server projection the
 * researcher cannot reorder here.
 */
import type { ComponentProps, ReactNode } from 'react'

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS } from '@/kubecode/icons/workspaceIcons'
import { cn } from '@/lib/utils'

export function Queue({ className, ...props }: ComponentProps<'section'>) {
  return <section className={cn('kubecode-ai-queue', className)} {...props} />
}

export function QueueSection({ className, defaultOpen = true, ...props }: ComponentProps<typeof Collapsible>) {
  return <Collapsible className={cn('kubecode-ai-queue-section', className)} defaultOpen={defaultOpen} {...props} />
}

export function QueueSectionTrigger({ children, className, ...props }: ComponentProps<typeof CollapsibleTrigger>) {
  return (
    <CollapsibleTrigger className={cn('kubecode-ai-disclosure kubecode-ai-queue-trigger', className)} {...props}>
      {children}
      <Icon className="kubecode-ai-disclosure-chevron" role="control" source={WORKSPACE_COMMAND_ICONS.expand.Icon} />
    </CollapsibleTrigger>
  )
}

export function QueueSectionLabel({ className, icon, label, ...props }: ComponentProps<'span'> & { label: string; icon?: ReactNode }) {
  return (
    <span className={cn('kubecode-ai-queue-label', className)} {...props}>
      {icon}
      <span>{label}</span>
    </span>
  )
}

export function QueueSectionContent({ className, ...props }: ComponentProps<typeof CollapsibleContent>) {
  return <CollapsibleContent className={cn('kubecode-ai-queue-content', className)} {...props} />
}

export function QueueList({ children, className, label, ...props }: ComponentProps<'div'> & { label: string }) {
  return (
    <div aria-label={label} className={cn('kubecode-ai-queue-list', className)} role="region" tabIndex={0} {...props}>
      <ul>{children}</ul>
    </div>
  )
}

export function QueueItem({ className, completed = false, ...props }: ComponentProps<'li'> & { completed?: boolean }) {
  return <li className={cn('kubecode-ai-queue-item', className)} data-completed={completed || undefined} {...props} />
}

export function QueueItemIndicator({ className, completed = false, ...props }: ComponentProps<'span'> & { completed?: boolean }) {
  return <span aria-hidden="true" className={cn('kubecode-ai-queue-indicator', className)} data-completed={completed || undefined} {...props} />
}

export function QueueItemContent({ className, ...props }: ComponentProps<'span'>) {
  return <span className={cn('kubecode-ai-queue-content-text', className)} {...props} />
}

export function QueueItemDescription({ className, ...props }: ComponentProps<'span'>) {
  return <span className={cn('kubecode-ai-queue-description', className)} {...props} />
}
