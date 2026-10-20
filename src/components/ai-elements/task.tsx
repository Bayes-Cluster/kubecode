/**
 * Adapted from AI Elements `task`
 * (https://ui.shadcn.com/docs/ai-elements/components/task,
 * registry https://registry.ai-sdk.dev/task.json, ai-elements 1.9.1).
 *
 * Adaptations (ADR 0233): this presents a member's *internal work steps*.
 * It is not a Kubecode Task (an RQ on the Kanban) and never admits, moves or
 * completes one. The trigger glyph is the vocabulary's internal-work object;
 * files are `ReferenceChip`s supplied by the caller.
 */
import type { ComponentProps } from 'react'

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS, WORKSPACE_OBJECT_ICONS } from '@/kubecode/icons/workspaceIcons'
import { cn } from '@/lib/utils'

export function Task({ className, defaultOpen = true, ...props }: ComponentProps<typeof Collapsible>) {
  return <Collapsible className={cn('kubecode-ai-task', className)} defaultOpen={defaultOpen} {...props} />
}

export function TaskTrigger({ className, title, ...props }: ComponentProps<typeof CollapsibleTrigger> & { title: string }) {
  return (
    <CollapsibleTrigger className={cn('kubecode-ai-disclosure', className)} {...props}>
      <Icon role="command" source={WORKSPACE_OBJECT_ICONS.workItem.Icon} />
      <span>{title}</span>
      <Icon className="kubecode-ai-disclosure-chevron" role="control" source={WORKSPACE_COMMAND_ICONS.expand.Icon} />
    </CollapsibleTrigger>
  )
}

export function TaskContent({ children, className, ...props }: ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent className={cn('kubecode-ai-task-content', className)} {...props}>
      <ul className="kubecode-ai-task-items">{children}</ul>
    </CollapsibleContent>
  )
}

export function TaskItem({ className, ...props }: ComponentProps<'li'>) {
  return <li className={cn('kubecode-ai-task-item', className)} {...props} />
}
