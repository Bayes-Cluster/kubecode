import { IconButton } from '@/components/workspace/IconButton'
import { StatusBadge } from '@/components/workspace/StatusBadge'
import type { Translator } from '@/lib/i18n'

import type { Conversation, Member, TaskCard, TaskDraft } from '../api'
import { Icon } from '../icons'
import { WORKSPACE_DESTINATION_ICONS as DESTINATIONS } from '../icons/workspaceIcons'
import { STATE_LABELS } from '../members/memberModel'
import type { WorkspaceView } from './workspaceRoute'

export type WorkspaceNavProps = {
  /** The view on screen, so its entry is marked as current. */
  active: WorkspaceView
  /** Live members (the roster), General Agent first. */
  members: Member[]
  /** Tasks waiting for the researcher: results to review, input requested. */
  needsYouTasks: TaskCard[]
  /** Proposals that are not on the board: the researcher decides whether to add them. */
  needsYouDrafts: TaskDraft[]
  /** Sessions waiting for a permission answer. */
  needsYouSessions: Conversation[]
  t: Translator
  taskCount: number
  onOpen: (view: Extract<WorkspaceView, 'general' | 'board' | 'resources' | 'members'>) => void
  onOpenDm: (member: Member) => void
  onOpenMember: (member: Member) => void
  onOpenDraft: (draft: TaskDraft) => void
  onOpenSession: (conversation: Conversation) => void
  onOpenTask: (task: TaskCard) => void
}

/**
 * The Workspace's organizing navigation: General, the Kanban board, Resources,
 * and the members, with everything that waits for the researcher gathered in
 * one place. Sessions, Teams, and Threads remain reachable below as execution
 * detail and history.
 */
export function WorkspaceNav({
  active,
  members,
  needsYouDrafts,
  needsYouSessions,
  needsYouTasks,
  onOpen,
  onOpenDm,
  onOpenMember,
  onOpenDraft,
  onOpenSession,
  onOpenTask,
  t,
  taskCount,
}: WorkspaceNavProps) {
  const entries = [
    { view: 'general', icon: DESTINATIONS.general.Icon, label: t('kubecode.channel.general') },
    { view: 'board', icon: DESTINATIONS.board.Icon, label: t('kubecode.nav.board') },
    { view: 'resources', icon: DESTINATIONS.resources.Icon, label: t('kubecode.nav.resources') },
    { view: 'members', icon: DESTINATIONS.members.Icon, label: t('kubecode.nav.members') },
  ] as const
  const waiting = needsYouTasks.length + needsYouDrafts.length + needsYouSessions.length
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
          {needsYouTasks.map((task) => (
            <li key={task.id}>
              <button className="kubecode-research-nav-item" type="button" onClick={() => onOpenTask(task)}>
                <span className="kubecode-research-nav-title">{task.title}</span>
                <StatusBadge tone="warn">
                  {task.stage === 'review'
                    ? t('kubecode.nav.needsReview')
                    : t('kubecode.nav.needsInput')}
                </StatusBadge>
              </button>
            </li>
          ))}
          {needsYouDrafts.map((draft) => (
            <li key={draft.id}>
              <button className="kubecode-research-nav-item" type="button" onClick={() => onOpenDraft(draft)}>
                <span className="kubecode-research-nav-title">{draft.title}</span>
                <StatusBadge tone="info">{t('kubecode.nav.needsProposal')}</StatusBadge>
              </button>
            </li>
          ))}
          {needsYouSessions.map((session) => (
            <li key={session.id}>
              <button className="kubecode-research-nav-item" type="button" onClick={() => onOpenSession(session)}>
                <span className="kubecode-research-nav-title">{session.title || t('kubecode.untitledSession')}</span>
                <StatusBadge tone="warn">{t('kubecode.nav.needsPermission')}</StatusBadge>
              </button>
            </li>
          ))}
        </ul>
      </details>
      {members.length > 0 && (
        <ul aria-label={t('kubecode.nav.roster')} className="kubecode-nav-members">
          {members.map((member) => (
            <li data-state={member.state} key={member.id}>
              <button
                className="kubecode-research-nav-item"
                type="button"
                onClick={() => onOpenMember(member)}
              >
                <span className="kubecode-research-nav-title" title={member.name}>@{member.handle}</span>
                {member.state !== 'active' && (
                  <StatusBadge tone="warn">{t(STATE_LABELS[member.state])}</StatusBadge>
                )}
              </button>
              {member.state === 'active' && (
                <IconButton
                  icon={<Icon role="navigation" size="secondary" source={DESTINATIONS.directMessage.Icon} />}
                  label={t('kubecode.members.messagePrivately', { name: member.name })}
                  onClick={() => onOpenDm(member)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
