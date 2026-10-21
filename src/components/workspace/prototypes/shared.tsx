import type { ReactNode } from 'react'

import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentMedia, AttachmentTitle } from '@/components/ui/attachment'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS, WORKSPACE_OBJECT_ICONS, type WorkspaceObjectKind } from '@/kubecode/icons/workspaceIcons'
import type { Translator } from '@/lib/i18n'

import type { FixtureMember } from './fixtures'
import type { PrototypeRequest } from './prototypeRoute'

export type ScreenProps = {
  request: PrototypeRequest
  t: Translator
  /** Opens another prototype screen. */
  go: (change: Partial<PrototypeRequest>) => void
}

export type ScreenParts = { main: ReactNode; inspector: ReactNode; inspectorLabel: string }

function initials(name: string): string {
  return name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()
}

/**
 * A member as the author of a message (ADR 0241): an official Avatar, the
 * name opening a HoverCard with the member's handle and role, the time, and
 * any activity.
 */
export function Author({ activity, member, time }: { member: FixtureMember; time: string; activity?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
      <Avatar className="size-7">
        <AvatarFallback>{initials(member.name)}</AvatarFallback>
      </Avatar>
      <HoverCard>
        <HoverCardTrigger asChild>
          <button className="font-medium text-foreground" type="button">{member.name}</button>
        </HoverCardTrigger>
        <HoverCardContent align="start" className="flex flex-col gap-1">
          <span className="font-medium">{member.name}</span>
          <span className="text-muted-foreground">@{member.handle} · {member.responsibility}</span>
        </HoverCardContent>
      </HoverCard>
      <Badge variant="secondary">{member.responsibility}</Badge>
      <time className="text-muted-foreground">{time}</time>
      {activity && <span className="text-muted-foreground">{activity}</span>}
    </div>
  )
}

export type FixtureReferenceState = { kind: 'changed' | 'removed' | 'unavailable'; label: string }

/** A fixture reference as an official Attachment; nothing is opened or fetched. */
export function FixtureReference({
  kind,
  onRemove,
  removeLabel,
  state,
  t,
  title,
  version,
}: {
  kind: WorkspaceObjectKind
  title: string
  version?: string
  state?: FixtureReferenceState
  t: Translator
  onRemove?: () => void
  removeLabel?: string
}) {
  const entry = WORKSPACE_OBJECT_ICONS[kind]
  return (
    <Attachment size="xs" state={state?.kind === 'removed' ? 'error' : 'done'}>
      <AttachmentMedia>
        <Icon role="file" source={entry.Icon} />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{title}</AttachmentTitle>
        <AttachmentDescription>
          {[t(entry.labelKey), version, state?.label].filter(Boolean).join(' · ')}
        </AttachmentDescription>
      </AttachmentContent>
      {onRemove && removeLabel && (
        <AttachmentActions>
          <AttachmentAction aria-label={removeLabel} onClick={onRemove}>
            <Icon role="command" source={WORKSPACE_COMMAND_ICONS.close.Icon} />
          </AttachmentAction>
        </AttachmentActions>
      )}
    </Attachment>
  )
}
