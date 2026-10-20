import { useContext, type ReactNode } from 'react'

import { MemberIdentity } from '@/components/workspace/MemberIdentity'

import { WorkspaceNavigationContext } from '../app/location/WorkspaceNavigation'
import type { IdentityView } from './memberIdentity'

export type IdentityProps = {
  view: IdentityView
  size?: 'sm' | 'md'
  /** Trailing details such as a message's time. */
  meta?: ReactNode
  /** What the member is doing, only as the runtime reports it (#220). */
  activity?: ReactNode
  /** The `data-focus-key` to return to when the profile closes. */
  from?: string
  className?: string
}

/**
 * Someone in a Workspace conversation, the same everywhere (ADR 0229 §1): a
 * live member's name opens their profile in the inspector; the researcher,
 * Kubecode, removed members, and agents that are no member are plain text.
 */
export function Identity({ activity, className, from, meta, size, view }: IdentityProps) {
  const navigation = useContext(WorkspaceNavigationContext)
  const memberId = view.memberId
  return (
    <MemberIdentity
      activity={activity}
      attention={view.attention}
      className={className}
      handle={view.handle}
      meta={meta}
      name={view.name}
      role={view.role}
      roleLabel={view.roleLabel}
      size={size}
      onOpen={navigation && memberId
        ? () => navigation.inspect({ kind: 'member', id: memberId }, from ? { from } : undefined)
        : undefined}
    />
  )
}
