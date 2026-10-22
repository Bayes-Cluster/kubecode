import type { ReactNode } from 'react'

import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import { initialsOf } from './memberInitials'
import { StatusBadge, type StatusTone } from './StatusBadge'

/** Who someone is in a Workspace conversation. It tones the avatar; the words say it. */
export type MemberRoleKind = 'manager' | 'specialist' | 'researcher' | 'system'

export type MemberAvatarProps = {
  name: string
  role: MemberRoleKind
  size?: 'sm' | 'md'
  className?: string
}

/**
 * The initials avatar of a member, the researcher, or Kubecode. It repeats the
 * name shown beside it, so assistive technology skips it.
 */
export function MemberAvatar({ className, name, role, size = 'md' }: MemberAvatarProps) {
  return (
    <Avatar
      aria-hidden="true"
      className={cn('kubecode-member-avatar', className)}
      data-role={role}
      data-testid="member-avatar"
      size={size === 'sm' ? 'sm' : 'default'}
    >
      <AvatarFallback>{initialsOf(name)}</AvatarFallback>
    </Avatar>
  )
}

export type MemberIdentityProps = {
  name: string
  /** Without the `@`. Absent for the researcher and Kubecode. */
  handle?: string
  role: MemberRoleKind
  /** The role in words, for example "Project manager" or "Specialist · Analysis". */
  roleLabel?: string
  /**
   * A membership state that needs the researcher, in words ("Needs setup",
   * "Removed"). An ordinary membership is not a status and is never shown as
   * one.
   */
  attention?: { label: string; tone: StatusTone }
  /**
   * What the member is doing, only as the runtime reports it (a run, a
   * question waiting). Membership is never shown as activity.
   */
  activity?: ReactNode
  /** Trailing details such as a message's time. */
  meta?: ReactNode
  /** Opens the member's profile; the name becomes the control. */
  onOpen?: () => void
  size?: 'sm' | 'md'
  className?: string
}

/**
 * One presentation of who someone is, shared by messages, the roster,
 * mentions, and profiles (ADR 0227): avatar, name, handle, and role in words, on the official
 * Avatar, Button and Badge (ADR 0247).
 */
export function MemberIdentity({
  activity,
  attention,
  className,
  handle,
  meta,
  name,
  onOpen,
  role,
  roleLabel,
  size = 'md',
}: MemberIdentityProps) {
  return (
    <span className={cn('kubecode-member-identity', className)} data-size={size}>
      <MemberAvatar name={name} role={role} size={size} />
      <span className="kubecode-member-identity-text">
        {onOpen ? (
          <Button className="kubecode-member-identity-name h-auto p-0" size="sm" type="button" variant="link" onClick={onOpen}>{name}</Button>
        ) : (
          <span className="kubecode-member-identity-name">{name}</span>
        )}
        {handle && <span className="kubecode-member-identity-handle">@{handle}</span>}
        {roleLabel && <span className="kubecode-member-identity-role">{roleLabel}</span>}
        {attention && <StatusBadge tone={attention.tone}>{attention.label}</StatusBadge>}
        {activity && <span className="kubecode-member-identity-activity">{activity}</span>}
        {meta && <span className="kubecode-member-identity-meta">{meta}</span>}
      </span>
    </span>
  )
}
