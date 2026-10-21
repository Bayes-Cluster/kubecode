/**
 * Adapted from AI Elements `sources`
 * (https://ui.shadcn.com/docs/ai-elements/components/sources,
 * registry https://registry.ai-sdk.dev/sources.json, ai-elements 1.9.1).
 *
 * Adaptations (ADR 0233): the caller words the trigger ("3 sources", localized
 * with its plural); a source is a list item holding a `ReferenceChip` that
 * opens a Workspace object instead of a link opening a new tab; the chevron
 * is the vocabulary's expand glyph.
 */
import type { ComponentProps } from 'react'

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS } from '@/kubecode/icons/workspaceIcons'
import { cn } from '@/lib/utils'

export function Sources({ className, ...props }: ComponentProps<typeof Collapsible>) {
  return <Collapsible className={cn('kubecode-ai-sources', className)} {...props} />
}

export function SourcesTrigger({ children, className, label, ...props }: ComponentProps<typeof CollapsibleTrigger> & { label: string }) {
  return (
    <CollapsibleTrigger className={cn('kubecode-ai-disclosure', className)} {...props}>
      {children ?? <span>{label}</span>}
      <Icon className="kubecode-ai-disclosure-chevron" role="control" source={WORKSPACE_COMMAND_ICONS.expand.Icon} />
    </CollapsibleTrigger>
  )
}

export function SourcesContent({ children, className, listLabel, ...props }: ComponentProps<typeof CollapsibleContent> & { listLabel?: string }) {
  return (
    <CollapsibleContent className={cn('kubecode-ai-sources-content', className)} {...props}>
      <ul aria-label={listLabel} className="kubecode-ai-sources-list">{children}</ul>
    </CollapsibleContent>
  )
}

export function Source({ className, ...props }: ComponentProps<'li'>) {
  return <li className={cn('kubecode-ai-source', className)} {...props} />
}
