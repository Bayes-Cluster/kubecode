/**
 * Adapted from AI Elements `message`
 * (https://ui.shadcn.com/docs/ai-elements/components/message,
 * registry https://registry.ai-sdk.dev/message.json, ai-elements 1.9.1).
 *
 * Adaptations (ADR 0233): no `ai` SDK types — a message is from `self` (the
 * researcher viewing) or a `member`; every message carries its author through
 * `MemberIdentity` because General is a group conversation; the researcher's
 * own message is a tinted bubble on the right (ADR 0239, superseding the
 * left-aligned rule of ADR 0233); `MessageResponse` is a reading container instead of
 * `streamdown`; actions are Workspace `IconButton`s. Branch switching and
 * attachments previews are left out (no regenerate and no upload, see ADR).
 */
import type { ComponentProps, ReactNode } from 'react'

import { cn } from '@/lib/utils'

export type MessageFrom = 'self' | 'member'

export type MessageProps = ComponentProps<'article'> & {
  from: MessageFrom
  /** The author, normally a `MemberIdentity`. */
  author: ReactNode
  /** Busy, failed, or another state of this message, in words. */
  state?: 'default' | 'pending' | 'failed'
}

export function Message({ author, children, className, from, state = 'default', ...props }: MessageProps) {
  return (
    <article className={cn('kubecode-ai-message', className)} data-from={from} data-state={state} {...props}>
      <header className="kubecode-ai-message-author">{author}</header>
      {children}
    </article>
  )
}

export function MessageContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('kubecode-ai-message-content', className)} {...props} />
}

/** Long-form reading content: headings, paragraphs, lists, tables, citations. */
export function MessageResponse({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('kubecode-ai-response', className)} {...props} />
}

export function MessageActions({ className, label, ...props }: ComponentProps<'div'> & { label: string }) {
  return <div aria-label={label} className={cn('kubecode-ai-message-actions', className)} role="toolbar" {...props} />
}

export function MessageToolbar({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('kubecode-ai-message-toolbar', className)} {...props} />
}
