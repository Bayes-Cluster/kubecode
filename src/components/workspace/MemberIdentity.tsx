import type { ReactNode } from 'react'

import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item'
import { statusToneVariant, type StatusTone } from '@/kubecode/statusTone'
import { cn } from '@/lib/utils'

import { initialsOf } from './memberInitials'

/** Who someone is in a Workspace conversation. It tones the avatar; the words say it. */
export type MemberRoleKind = 'manager' | 'specialist' | 'researcher' | 'system'

export type MemberAvatarProps = {
  name: string
  role: MemberRoleKind
  size?: 'sm' | 'md'
  className?: string
}

/**
 * The initials avatar of a member, the researcher, or Kubecode: the official
 * Avatar in its own sizes. It repeats the name shown beside it, so assistive
 * technology skips it.
 */
export function MemberAvatar({ className, name, role, size = 'md' }: MemberAvatarProps) {
  return (
    <Avatar
      aria-hidden="true"
      className={className}
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
  /** Layout only: where the identity sits and how much room it may take. */
  className?: string
}

/**
 * One presentation of who someone is, shared by messages, the roster,
 * mentions, and profiles (ADR 0227): the official Item with the Avatar as
 * its media, the name as its title (a link Button when it opens the
 * profile), and the handle, role, attention, activity and details as its
 * description (ADR 0255). It is a pass-through with no appearance of its
 * own; it carries the contract that the avatar is hidden from assistive
 * technology and that membership is never shown as activity.
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
  const details = handle || roleLabel || attention || activity || meta
  return (
    <Item className={cn('w-fit max-w-full flex-nowrap', className)} data-size={size} size="compact">
      <ItemMedia>
        <MemberAvatar name={name} role={role} size={size} />
      </ItemMedia>
      <ItemContent className="min-w-0 flex-row flex-wrap items-baseline gap-x-2 gap-y-0">
        <ItemTitle className="min-w-0 [overflow-wrap:anywhere]">
          {onOpen ? <Button size="inline" type="button" variant="link" onClick={onOpen}>{name}</Button> : name}
        </ItemTitle>
        {details && (
          <ItemDescription>
            <span className="inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-0 [overflow-wrap:anywhere]">
              {handle && <span>@{handle}</span>}
              {roleLabel && <span>{roleLabel}</span>}
              {attention && <Badge variant={statusToneVariant(attention.tone)}>{attention.label}</Badge>}
              {activity && <span>{activity}</span>}
              {meta && <span>{meta}</span>}
            </span>
          </ItemDescription>
        )}
      </ItemContent>
    </Item>
  )
}
