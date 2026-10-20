/**
 * Adapted from AI Elements `tool`
 * (https://ui.shadcn.com/docs/ai-elements/components/tool,
 * registry https://registry.ai-sdk.dev/tool.json, ai-elements 1.9.1).
 *
 * Adaptations (ADR 0233): a local `ToolState` replaces the `ai` SDK's
 * `ToolUIPart` states; the state is a Workspace `StatusBadge` with a caller
 * label; input and output are preformatted text, not the `code-block`
 * (Shiki) item; the "Parameters"/"Result"/"Error" headings come from the
 * caller. Finishing a tool call never completes research (ADR 0230).
 */
import type { ComponentProps, ReactNode } from 'react'

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { StatusBadge, type StatusTone } from '@/components/workspace/StatusBadge'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS } from '@/kubecode/icons/workspaceIcons'
import { cn } from '@/lib/utils'

export type ToolState = 'pending' | 'running' | 'awaiting-approval' | 'completed' | 'failed' | 'denied'

const TOOL_STATE_TONES: Record<ToolState, StatusTone> = {
  pending: 'muted',
  running: 'info',
  'awaiting-approval': 'warn',
  completed: 'ok',
  failed: 'danger',
  denied: 'warn',
}

export function Tool({ className, ...props }: ComponentProps<typeof Collapsible>) {
  return <Collapsible className={cn('kubecode-ai-tool', className)} {...props} />
}

export type ToolHeaderProps = {
  title: ReactNode
  state: ToolState
  stateLabel: string
  className?: string
}

export function ToolHeader({ className, state, stateLabel, title }: ToolHeaderProps) {
  return (
    <CollapsibleTrigger className={cn('kubecode-ai-tool-header kubecode-ai-disclosure', className)} data-state-kind={state}>
      <span className="kubecode-ai-tool-title">{title}</span>
      <StatusBadge tone={TOOL_STATE_TONES[state]}>{stateLabel}</StatusBadge>
      <Icon className="kubecode-ai-disclosure-chevron" role="control" source={WORKSPACE_COMMAND_ICONS.expand.Icon} />
    </CollapsibleTrigger>
  )
}

export function ToolContent({ className, ...props }: ComponentProps<typeof CollapsibleContent>) {
  return <CollapsibleContent className={cn('kubecode-ai-tool-content', className)} {...props} />
}

export function ToolInput({ className, input, label, ...props }: ComponentProps<'div'> & { input: string; label: string }) {
  return (
    <div className={cn('kubecode-ai-tool-section', className)} {...props}>
      <h4>{label}</h4>
      <pre tabIndex={0}>{input}</pre>
    </div>
  )
}

export type ToolOutputProps = ComponentProps<'div'> & {
  output?: string
  errorText?: string
  label: string
}

export function ToolOutput({ className, errorText, label, output, ...props }: ToolOutputProps) {
  if (!output && !errorText) return null
  return (
    <div className={cn('kubecode-ai-tool-section', className)} data-error={errorText ? 'true' : undefined} {...props}>
      <h4>{label}</h4>
      <pre tabIndex={0}>{errorText ?? output}</pre>
    </div>
  )
}
