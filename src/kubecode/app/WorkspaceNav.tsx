import { useId } from 'react'

import { IconButton } from '@/components/workspace/IconButton'
import { MemberAvatar, type MemberRoleKind } from '@/components/workspace/MemberIdentity'
import { StatusBadge } from '@/components/workspace/StatusBadge'
import type { Translator } from '@/lib/i18n'

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
    <li key={entry.view}>
      <button
        aria-current={active === entry.view ? 'page' : undefined}
        className="kubecode-research-nav-item"
        type="button"
        onClick={() => onOpen(entry.view)}
      >
        <Icon role="navigation" size="secondary" source={entry.icon} />
        <span className="kubecode-research-nav-title">{entry.label}</span>
        {entry.view === 'board' && taskCount > 0 && (
          <StatusBadge tone="muted">{taskCount}</StatusBadge>
        )}
        {entry.view === 'needs-you' && (
          <StatusBadge tone={waiting > 0 ? 'warn' : 'muted'}>{waiting}</StatusBadge>
        )}
        {entry.view === 'general' && undeliveredGeneral > 0 && (
          <StatusBadge tone="danger">{t('kubecode.nav.notDelivered', { count: undeliveredGeneral })}</StatusBadge>
        )}
      </button>
    </li>
  )
  const rosterHeading = useId()
  const directHeading = useId()
  // A private conversation shows once it exists, and while it is being opened.
  const direct = members.filter((member) => member.dm_conversation_id !== null || active === `dm:${member.id}`)
  return (
    <section aria-label={t('kubecode.nav.workspace')} className="kubecode-workspace-nav">
      <ul className="kubecode-research-nav-list">
        {places.map(destination)}
      </ul>
      {members.length > 0 && (
        <div className="kubecode-nav-roster">
          <h3 className="kubecode-nav-heading" id={rosterHeading}>{t('kubecode.nav.roster')}</h3>
          <ul aria-labelledby={rosterHeading} className="kubecode-nav-members">
            {members.map((member) => (
              <li data-state={member.state} key={member.id}>
                <Identity
                  size="sm"
                  view={memberView(member, t)}
                  onOpen={() => onInspectMember(member.id)}
                />
                {member.state === 'active' && (
                  <IconButton
                    icon={<Icon role="navigation" size="secondary" source={DESTINATIONS.directMessage.Icon} />}
                    label={t('kubecode.members.messagePrivately', { name: member.name })}
                    onClick={() => onOpenDm(member.id)}
                  />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {direct.length > 0 && (
        <div className="kubecode-nav-direct">
          <h3 className="kubecode-nav-heading" id={directHeading}>{t('kubecode.nav.directMessages')}</h3>
          <ul aria-labelledby={directHeading} className="kubecode-research-nav-list">
            {direct.map((member) => (
              <li key={member.id}>
                <button
                  aria-current={active === `dm:${member.id}` ? 'page' : undefined}
                  className="kubecode-research-nav-item"
                  type="button"
                  onClick={() => onOpenDm(member.id)}
                >
                  <MemberAvatar name={member.name} role={roleKind(member)} size="sm" />
                  <span className="kubecode-research-nav-title">{member.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
