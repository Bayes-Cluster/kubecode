import { useContext, type ReactNode } from 'react'

import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { initialsOf } from '@/components/workspace/memberInitials'
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
 * Someone in General or a DM (ADR 0242): the official Avatar with their
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
    <button className="kubecode-member-identity-name" type="button" onClick={open}>{view.name}</button>
  ) : (
    <span className="kubecode-member-identity-name">{view.name}</span>
  )
  return (
    <span className={cn('kubecode-member-identity', className)} data-size={size}>
      <Avatar aria-hidden="true" className="kubecode-conversation-avatar" data-role={view.role} size={size === 'sm' ? 'sm' : 'default'}>
        <AvatarFallback data-testid="member-avatar">{initialsOf(view.name)}</AvatarFallback>
      </Avatar>
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
