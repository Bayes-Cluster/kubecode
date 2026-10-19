import { BellRing, Hash, KanbanSquare, Library, MessageCircle, Users } from 'lucide-react'

import { IconButton } from '@/components/workspace/IconButton'
import { StatusBadge } from '@/components/workspace/StatusBadge'
import type { Translator } from '@/lib/i18n'

import type { Conversation, Member, TaskCard } from '../api'
import type { WorkspaceView } from './workspaceRoute'

export type WorkspaceNavProps = {
  /** The view on screen, so its entry is marked as current. */
  active: WorkspaceView
  /** Live members (the roster), General Agent first. */
  members: Member[]
  /** Tasks waiting for the researcher: results to review, input requested. */
  needsYouTasks: TaskCard[]
  /** Sessions waiting for a permission answer. */
  needsYouSessions: Conversation[]
  t: Translator
  taskCount: number
  onOpen: (view: Extract<WorkspaceView, 'general' | 'board' | 'resources' | 'members'>) => void
  onOpenDm: (member: Member) => void
  onOpenMember: (member: Member) => void
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
  needsYouSessions,
  needsYouTasks,
  onOpen,
  onOpenDm,
  onOpenMember,
  onOpenSession,
  onOpenTask,
  t,
  taskCount,
}: WorkspaceNavProps) {
  const entries = [
    { view: 'general', icon: <Hash aria-hidden size={14} />, label: t('kubecode.channel.general') },
    { view: 'board', icon: <KanbanSquare aria-hidden size={14} />, label: t('kubecode.nav.board') },
    { view: 'resources', icon: <Library aria-hidden size={14} />, label: t('kubecode.nav.resources') },
    { view: 'members', icon: <Users aria-hidden size={14} />, label: t('kubecode.nav.members') },
  ] as const
  const waiting = needsYouTasks.length + needsYouSessions.length
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
              {entry.icon}
              <span className="kubecode-research-nav-title">{entry.label}</span>
              {entry.view === 'board' && taskCount > 0 && (
                <StatusBadge tone="muted">{taskCount}</StatusBadge>
              )}
            </button>
          </li>
        ))}
      </ul>
      <details className="kubecode-needs-you" data-waiting={waiting > 0} open={waiting > 0 && waiting <= 3}>
        <summary>
          <BellRing aria-hidden size={14} />
          <span>{t('kubecode.nav.needsYou')}</span>
          <StatusBadge tone={waiting > 0 ? 'warn' : 'muted'}>{waiting}</StatusBadge>
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
        <ul aria-label={t('kubecode.nav.members')} className="kubecode-nav-members">
          {members.map((member) => (
            <li data-state={member.state} key={member.id}>
              <button
                className="kubecode-research-nav-item"
                type="button"
                onClick={() => onOpenMember(member)}
              >
                <span className="kubecode-research-nav-title" title={member.name}>@{member.handle}</span>
                {member.state !== 'active' && (
                  <StatusBadge tone="warn">{t('kubecode.members.state.setup_required')}</StatusBadge>
                )}
              </button>
              {member.state === 'active' && (
                <IconButton
                  icon={<MessageCircle aria-hidden size={14} />}
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
