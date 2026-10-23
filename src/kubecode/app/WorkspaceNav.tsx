import { useId } from 'react'

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { MemberAvatar, type MemberRoleKind } from '@/components/workspace/MemberIdentity'
import { StatusBadge } from '@/components/workspace/StatusBadge'
import type { Translator } from '@/lib/i18n'
import { cn } from '@/lib/utils'

import type { Member } from '../api'
import { Icon } from '../icons'
import { WORKSPACE_DESTINATION_ICONS as DESTINATIONS } from '../icons/workspaceIcons'
import { Identity } from '../members/Identity'
import { memberView } from '../members/memberIdentity'
import type { NeedsYouEntry } from './location/needsYou'
import type { ViewKey } from './location/workspaceLocation'

export type WorkspaceNavDestination = 'general' | 'board' | 'resources' | 'needs-you' | 'members'

export type WorkspaceNavProps = {
  /** The view on screen, so its entry is marked as current; nothing on execution history or a question. */
  active: ViewKey | null
  /** Live members (the roster), General Agent first. */
  members: readonly Member[]
  /** Everything that waits for the researcher, each saying where it opens. */
  needsYou: NeedsYouEntry[]
  /** The researcher's messages in General that reached nobody yet. */
  undeliveredGeneral?: number
  t: Translator
  taskCount: number
  onOpen: (view: WorkspaceNavDestination) => void
  /** Opens a member's profile in the inspector. */
  onInspectMember: (memberId: string) => void
  /** Opens the private conversation with a member. */
  onOpenDm: (memberId: string) => void
}

/** The role a member plays, as the shared identity tones it. */
function roleKind(member: Member): MemberRoleKind {
  return member.role === 'general' ? 'manager' : 'specialist'
}

/**
 * The active Workspace's organizing navigation (ADR 0228 §1, ADR 0234): the
 * five destinations General, Kanban, Resources, Needs you (counting what
 * waits) and Members; the members themselves under their own heading, whose
 * names open their profiles, each with a private-message shortcut; and the
 * private conversations. Execution history is reachable below it, never from
 * here.
 */
export function WorkspaceNav({
  active,
  members,
  needsYou,
  onInspectMember,
  onOpen,
  onOpenDm,
  t,
  taskCount,
  undeliveredGeneral = 0,
}: WorkspaceNavProps) {
  const places = [
    { view: 'general', icon: DESTINATIONS.general.Icon, label: t('kubecode.channel.general') },
    { view: 'board', icon: DESTINATIONS.board.Icon, label: t('kubecode.nav.board') },
    { view: 'resources', icon: DESTINATIONS.resources.Icon, label: t('kubecode.nav.resources') },
    { view: 'needs-you', icon: DESTINATIONS.needsYou.Icon, label: t('kubecode.nav.needsYou') },
    { view: 'members', icon: DESTINATIONS.members.Icon, label: t('kubecode.nav.members') },
  ] as const
  const waiting = needsYou.length
  const destination = (entry: typeof places[number]) => (
    <SidebarMenuItem key={entry.view}>
      <SidebarMenuButton
        aria-current={active === entry.view ? 'page' : undefined}
        className="h-auto min-h-8"
        isActive={active === entry.view}
        onClick={() => onOpen(entry.view)}
      >
        <Icon role="navigation" size="secondary" source={entry.icon} />
        <span className="min-w-0 flex-1 truncate">{entry.label}</span>
        {entry.view === 'board' && taskCount > 0 && (
          <StatusBadge tone="muted">{taskCount}</StatusBadge>
        )}
        {entry.view === 'needs-you' && (
          <StatusBadge tone={waiting > 0 ? 'warn' : 'muted'}>{waiting}</StatusBadge>
        )}
        {entry.view === 'general' && undeliveredGeneral > 0 && (
          <StatusBadge tone="danger">{t('kubecode.nav.notDelivered', { count: undeliveredGeneral })}</StatusBadge>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
  const rosterHeading = useId()
  const directHeading = useId()
  // A private conversation shows once it exists, and while it is being opened.
  const direct = members.filter((member) => member.dm_conversation_id !== null || active === `dm:${member.id}`)
  return (
    <section aria-label={t('kubecode.nav.workspace')} className="flex flex-col">
      <SidebarGroup>
        <SidebarMenu>
          {places.map(destination)}
        </SidebarMenu>
      </SidebarGroup>
      {members.length > 0 && (
        <SidebarGroup>
          <SidebarGroupLabel asChild>
            <h3 id={rosterHeading}>{t('kubecode.nav.roster')}</h3>
          </SidebarGroupLabel>
          <SidebarMenu aria-labelledby={rosterHeading}>
            {members.map((member) => (
              <SidebarMenuItem
                className={cn('px-2 py-1', member.state === 'active' && 'pr-8')}
                data-state={member.state}
                key={member.id}
              >
                <Identity
                  size="sm"
                  view={memberView(member, t)}
                  onOpen={() => onInspectMember(member.id)}
                />
                {member.state === 'active' && (
                  <SidebarMenuAction
                    aria-label={t('kubecode.members.messagePrivately', { name: member.name })}
                    title={t('kubecode.members.messagePrivately', { name: member.name })}
                    onClick={() => onOpenDm(member.id)}
                  >
                    <Icon role="navigation" size="secondary" source={DESTINATIONS.directMessage.Icon} />
                  </SidebarMenuAction>
                )}
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      )}
      {direct.length > 0 && (
        <SidebarGroup>
          <SidebarGroupLabel asChild>
            <h3 id={directHeading}>{t('kubecode.nav.directMessages')}</h3>
          </SidebarGroupLabel>
          <SidebarMenu aria-labelledby={directHeading}>
            {direct.map((member) => (
              <SidebarMenuItem key={member.id}>
                <SidebarMenuButton
                  aria-current={active === `dm:${member.id}` ? 'page' : undefined}
                  isActive={active === `dm:${member.id}`}
                  onClick={() => onOpenDm(member.id)}
                >
                  <MemberAvatar name={member.name} role={roleKind(member)} size="sm" />
                  <span>{member.name}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      )}
    </section>
  )
}
