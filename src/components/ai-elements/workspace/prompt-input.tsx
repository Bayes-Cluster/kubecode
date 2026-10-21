/**
 * Adapted from AI Elements `prompt-input`
 * (https://ui.shadcn.com/docs/ai-elements/components/prompt-input,
 * registry https://registry.ai-sdk.dev/prompt-input.json, ai-elements 1.9.1).
 *
 * Adaptations (ADR 0233): only the card structure is taken — `PromptInput`,
 * `PromptInputHeader`, `PromptInputBody`, `PromptInputFooter`,
 * `PromptInputTools`. The text box, keyboard/IME contract, mentions, send and
 * stop stay in the Workspace `Composer` (ADR 0222), placed in the body. Not
 * taken: file attachments and drag-and-drop, speech input, model select,
 * command palette, the `ai` SDK submit status, `nanoid`, `input-group`.
 */
import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

export type PromptInputProps = ComponentProps<'div'> & { busy?: boolean }

/** The composer card: hairline, soft elevation, and the Harness radius. */
export function PromptInput({ busy, className, ...props }: PromptInputProps) {
  return <div aria-busy={busy || undefined} className={cn('kubecode-ai-prompt-input', className)} {...props} />
}

export function PromptInputHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('kubecode-ai-prompt-input-header', className)} {...props} />
}

export function PromptInputBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('kubecode-ai-prompt-input-body', className)} {...props} />
}

export function PromptInputFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('kubecode-ai-prompt-input-footer', className)} {...props} />
}

export function PromptInputTools({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('kubecode-ai-prompt-input-tools', className)} {...props} />
}
