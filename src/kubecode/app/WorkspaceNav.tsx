import { useId } from 'react'

import { IconButton } from '@/components/workspace/IconButton'
import { MemberAvatar, MemberIdentity, type MemberRoleKind } from '@/components/workspace/MemberIdentity'
import { StatusBadge } from '@/components/workspace/StatusBadge'
import type { Translator } from '@/lib/i18n'

import type { Member } from '../api'
import { Icon } from '../icons'
import { WORKSPACE_DESTINATION_ICONS as DESTINATIONS } from '../icons/workspaceIcons'
import { STATE_LABELS } from '../members/memberModel'
import type { NeedsYouEntry, NeedsYouTarget } from './location/needsYou'
import type { ViewKey } from './location/workspaceLocation'

export type WorkspaceNavDestination = 'general' | 'board' | 'resources' | 'members'

export type WorkspaceNavProps = {
  /** The view on screen, so its entry is marked as current; nothing on execution history or a question. */
  active: ViewKey | null
  /** Live members (the roster), General Agent first. */
  members: Member[]
  /** Everything that waits for the researcher, each saying where it opens. */
  needsYou: NeedsYouEntry[]
  t: Translator
  taskCount: number
  onOpen: (view: WorkspaceNavDestination) => void
  /** Opens what a Needs-you entry is about. */
  onOpenTarget: (target: NeedsYouTarget) => void
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
 * The active Workspace's organizing navigation (ADR 0228 §1): General, the
 * Kanban board, Resources, and Members; everything that waits for the
 * researcher, gathered in one place; the members, whose names open their
 * profiles; and the private conversations. Execution history is reachable
 * below it, never from here.
 */
export function WorkspaceNav({
  active,
  members,
  needsYou,
  onInspectMember,
  onOpen,
  onOpenDm,
  onOpenTarget,
  t,
  taskCount,
}: WorkspaceNavProps) {
  const entries = [
    { view: 'general', icon: DESTINATIONS.general.Icon, label: t('kubecode.channel.general') },
    { view: 'board', icon: DESTINATIONS.board.Icon, label: t('kubecode.nav.board') },
    { view: 'resources', icon: DESTINATIONS.resources.Icon, label: t('kubecode.nav.resources') },
    { view: 'members', icon: DESTINATIONS.members.Icon, label: t('kubecode.nav.members') },
  ] as const
  const directHeading = useId()
  const waiting = needsYou.length
  // A private conversation shows once it exists, and while it is being opened.
  const direct = members.filter((member) => member.dm_conversation_id !== null || active === `dm:${member.id}`)
  return (
    <section aria-label={t('kubecode.nav.workspace')} className="kubecode-workspace-nav">
      <ul className="kubecode-research-nav-list">
        {entries.map((entry) => (
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
            </button>
          </li>
        ))}
      </ul>
      <details className="kubecode-needs-you" data-waiting={waiting > 0} open={waiting > 0}>
        <summary>
          <Icon role="navigation" size="secondary" source={DESTINATIONS.needsYou.Icon} />
          <span>{t('kubecode.nav.needsYou')}</span>
          <StatusBadge title={t('kubecode.nav.needsYou')} tone={waiting > 0 ? 'warn' : 'muted'}>{waiting}</StatusBadge>
        </summary>
        {waiting === 0 && <p className="kubecode-research-nav-note">{t('kubecode.nav.needsYouNone')}</p>}
        <ul className="kubecode-research-nav-list">
          {needsYou.map((entry) => (
            <li key={entry.key}>
              <button className="kubecode-research-nav-item" type="button" onClick={() => onOpenTarget(entry.target)}>
                <span className="kubecode-research-nav-title">{entry.title}</span>
                <StatusBadge tone={entry.reason.tone}>{entry.reason.label}</StatusBadge>
              </button>
            </li>
          ))}
        </ul>
      </details>
      {members.length > 0 && (
        <ul aria-label={t('kubecode.nav.roster')} className="kubecode-nav-members">
          {members.map((member) => (
            <li data-state={member.state} key={member.id}>
              <MemberIdentity
                attention={member.state === 'setup_required'
                  ? { label: t(STATE_LABELS[member.state]), tone: 'warn' }
                  : undefined}
                handle={member.handle}
                name={member.name}
                role={roleKind(member)}
                size="sm"
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
