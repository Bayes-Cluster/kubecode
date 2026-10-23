import type { ComponentProps } from 'react'

import { Message } from '@/components/ai-elements/message'
import { cn } from '@/lib/utils'

export type ConversationMessageProps = ComponentProps<'article'> & {
  /** The researcher viewing (`self`, on the right) or a member (on the left), ADR 0239. */
  from: 'self' | 'member'
  /** How far it got: the official Message's pending and failed looks (ADR 0242). */
  state?: 'default' | 'pending' | 'failed'
}

/**
 * One message of General or a DM: an `article` (so it is announced and
 * found as one) around the official AI Elements `Message`, the researcher's
 * own as the user's bubble and a member's as the assistant's.
 */
export function ConversationMessage({ children, className, from, state = 'default', ...props }: ConversationMessageProps) {
  return (
    <article className={cn('kubecode-message group/message', className)} data-from={from} data-state={state} {...props}>
      <Message className="kubecode-message-inner" from={from === 'self' ? 'user' : 'assistant'}>
        {children}
      </Message>
    </article>
  )
}
