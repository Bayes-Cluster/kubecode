import { useContext, type ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { MemberAvatar } from '@/components/workspace/MemberIdentity'
import { cn } from '@/lib/utils'

import { WorkspaceNavigationContext } from '../app/location/WorkspaceNavigation'
import { statusBadgeVariant } from '../channel/statusBadge'
import type { IdentityView } from './memberIdentity'

export type ConversationIdentityProps = {
  view: IdentityView
  size?: 'sm' | 'md'
  /** Trailing details such as a message's time. */
  meta?: ReactNode
  /** The `data-focus-key` to return to when the profile closes. */
  from?: string
  className?: string
}

/**
 * Someone in General or a DM (ADR 0242): the shared MemberAvatar with their
 * initials, the name (a live member's opens the profile), handle and role in
 * words, and a HoverCard that repeats who they are for a pointer.
 */
export function ConversationIdentity({ className, from, meta, size = 'md', view }: ConversationIdentityProps) {
  const navigation = useContext(WorkspaceNavigationContext)
  const memberId = view.memberId
  const open = memberId && navigation
    ? () => navigation.inspect({ kind: 'member', id: memberId }, from ? { from } : undefined)
    : undefined
  const name = open ? (
    <Button className="kubecode-member-identity-name h-auto p-0" size="sm" type="button" variant="link" onClick={open}>{view.name}</Button>
  ) : (
    <span className="kubecode-member-identity-name">{view.name}</span>
  )
  return (
    <span className={cn('kubecode-member-identity', className)} data-size={size}>
      <MemberAvatar className="kubecode-conversation-avatar" name={view.name} role={view.role} size={size} />
      <span className="kubecode-member-identity-text">
        {view.handle || view.roleLabel ? (
          <HoverCard closeDelay={80} openDelay={400}>
            <HoverCardTrigger asChild>{name}</HoverCardTrigger>
            <HoverCardContent align="start" className="kubecode-identity-card">
              <span className="kubecode-identity-card-name">{view.name}</span>
              {view.handle && <span className="kubecode-member-identity-handle">@{view.handle}</span>}
              {view.roleLabel && <span className="kubecode-member-identity-role">{view.roleLabel}</span>}
            </HoverCardContent>
          </HoverCard>
        ) : name}
        {view.handle && <span className="kubecode-member-identity-handle">@{view.handle}</span>}
        {view.roleLabel && <span className="kubecode-member-identity-role">{view.roleLabel}</span>}
        {view.attention && <Badge variant={statusBadgeVariant(view.attention.tone)}>{view.attention.label}</Badge>}
        {meta && <span className="kubecode-member-identity-meta">{meta}</span>}
      </span>
    </span>
  )
}
