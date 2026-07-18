import { useEffect, useMemo, useState } from 'react'
import {
  Archive,
  CaretDown,
  CaretRight,
  DotsThree,
  Folder,
  Funnel,
  GitFork,
  Plus,
  Trash,
  UsersThree,
} from '@phosphor-icons/react'

import { AiAgentIcon } from '@/components/AiAgentIcon'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { createTranslator } from '@/lib/i18n'
import { trackEvent } from '@/lib/telemetry'

import type { Conversation, KubecodeApi, Project, RunStatus, TeamRole, TeamSnapshot } from './api'
import { DeleteTeamDialog } from './DeleteTeamDialog'
import {
  buildSessionSections,
  readSessionListPreferences,
  writeSessionListPreferences,
  type SessionAgentFilter,
  type SessionListPreferences,
  type SessionSort,
} from './sessionList'

type Translator = ReturnType<typeof createTranslator>

type SessionSidebarListProps = {
  activeConversationId: string | null
  activeProjectId: string | null
  api: KubecodeApi
  conversations: Conversation[]
  expandedProjectIds: string[]
  onConversationCreated: (conversation: Conversation) => void
  onConversationRemoved: (conversationId: string) => void
  onConversationUpdated: (conversation: Conversation) => void
  onError: (cause: unknown) => void
  onNewSession: (projectId: string) => void
  onProjectDelete: (projectId: string) => void
  onProjectSelect: (projectId: string) => void
  onProjectToggle: (projectId: string) => void
  onProjectWorkspacesToggle: (projectId: string) => void
  onSelect: (projectId: string, conversationId: string) => void
  projects: Project[]
  projectStatuses?: Record<string, 'running' | 'stuck' | null>
  query?: string
  t: Translator
  teams?: TeamSnapshot[]
}

export function SessionSidebarList({
  activeConversationId,
  activeProjectId,
  api,
  conversations,
  expandedProjectIds,
  onConversationCreated,
  onConversationRemoved,
  onConversationUpdated,
  onError,
  onNewSession,
  onProjectDelete,
  onProjectSelect,
  onProjectToggle,
  onProjectWorkspacesToggle,
  onSelect,
  projects,
  projectStatuses = {},
  query = '',
  t,
  teams = [],
}: SessionSidebarListProps) {
  const [preferences, setPreferences] = useState<SessionListPreferences>(() => (
    readSessionListPreferences(localStorage)
  ))
  const [deleteTarget, setDeleteTarget] = useState<TeamDeleteTarget | null>(null)
  const visiblePreferences = useMemo(
    () => ({ ...preferences, query }),
    [preferences, query],
  )
  const visibleSections = useMemo(
    () => buildSessionSections(conversations, visiblePreferences),
    [conversations, visiblePreferences],
  )
  const conversationsById = useMemo(
    () => new Map(conversations.map((conversation) => [conversation.id, conversation])),
    [conversations],
  )
  const teamByConversation = useMemo(() => new Map(
    teams.flatMap((team) => team.members.map((member) => [member.conversation_id, {
      member,
      team: team.team,
    }] as const)),
  ), [teams])
  const visibleConversationIds = useMemo(() => new Set(
    visibleSections.flatMap((section) => section.sessions.map((conversation) => conversation.id)),
  ), [visibleSections])
  const teamConversationIds = useMemo(() => new Set(conversations.flatMap((conversation) => {
    const teamId = conversation.team_id ?? teamByConversation.get(conversation.id)?.team.id
    return teamId ? [conversation.id] : []
  })), [conversations, teamByConversation])
  const sections = useMemo(
    () => buildSessionSections(
      conversations.filter((conversation) => !teamConversationIds.has(conversation.id)),
      visiblePreferences,
    ),
    [conversations, teamConversationIds, visiblePreferences],
  )
  const teamGroups = useMemo(() => {
    const grouped = new Map<string, TeamSessionGroup>()
    for (const snapshot of teams) {
      grouped.set(snapshot.team.id, {
        id: snapshot.team.id,
        projectId: snapshot.team.project_id ?? snapshot.leader_conversation.project_id,
        status: snapshot.team.status,
        title: snapshot.team.title.trim(),
        members: snapshot.members.flatMap((member) => {
          const conversation = conversationsById.get(member.conversation_id)
          return conversation && visibleConversationIds.has(conversation.id)
            ? [{ conversation, role: member.role }]
            : []
        }),
      })
    }
    for (const conversation of conversations) {
      const membership = teamByConversation.get(conversation.id)
      const teamId = conversation.team_id ?? membership?.team.id
      if (!teamId || !visibleConversationIds.has(conversation.id)) continue
      const group = grouped.get(teamId) ?? {
        id: teamId,
        projectId: conversation.project_id,
        status: conversation.team_status ?? null,
        title: conversation.team_title?.trim() ?? '',
        members: [],
      }
      if (!group.members.some((member) => member.conversation.id === conversation.id)) {
        group.members.push({
          conversation,
          role: conversation.team_role ?? membership?.member.role ?? 'teammate',
        })
      }
      grouped.set(teamId, group)
    }
    return Array.from(grouped.values())
      .filter((group) => group.members.length > 0)
      .map((group) => ({
        ...group,
        title: group.title || group.members.find((member) => member.role === 'leader')?.conversation.title
          || t('kubecode.teamSession'),
        members: [...group.members].sort((left, right) => (
          Number(right.role === 'leader') - Number(left.role === 'leader')
        )),
      }))
  }, [conversations, conversationsById, t, teamByConversation, teams, visibleConversationIds])
  const projectGroups = useMemo(() => {
    const visibleSoloSessions = sections.flatMap((section) => section.sessions)
    return projects.map((project) => ({
      project,
      sessions: visibleSoloSessions.filter((conversation) => conversation.project_id === project.id),
      teams: teamGroups.filter((team) => team.projectId === project.id),
    }))
  }, [projects, sections, teamGroups])

  useEffect(() => writeSessionListPreferences(localStorage, preferences), [preferences])

  const archive = async (conversation: Conversation) => {
    try {
      const updated = await api.archiveConversation(conversation.id, !conversation.archived)
      onConversationUpdated(updated)
      trackEvent('kubecode_session_archived', {
        agent_id: conversation.agent_id,
        archived: updated.archived ? 1 : 0,
      })
    } catch (cause) {
      onError(cause)
    }
  }

  const deleteConversation = async (
    conversation: Conversation,
    removedConversationIds = [conversation.id],
  ) => {
    try {
      await api.deleteConversation(conversation.id)
      for (const conversationId of removedConversationIds) onConversationRemoved(conversationId)
      trackEvent('kubecode_session_deleted', {
        agent_id: conversation.agent_id,
        team_size: removedConversationIds.length,
      })
      return true
    } catch (cause) {
      onError(cause)
      return false
    }
  }

  const remove = async (conversation: Conversation) => {
    const membership = teamByConversation.get(conversation.id)
    const role = conversation.team_role ?? membership?.member.role
    if (role === 'teammate') return
    if (role !== 'leader') {
      await deleteConversation(conversation)
      return
    }
    const teamId = conversation.team_id ?? membership?.team.id
    const snapshot = teams.find((candidate) => candidate.team.id === teamId)
    const conversationIds = snapshot
      ? snapshot.members.map((member) => member.conversation_id)
      : conversations
        .filter((candidate) => candidate.team_id === teamId)
        .map((candidate) => candidate.id)
    setDeleteTarget({
      conversation,
      conversationIds: conversationIds.length ? conversationIds : [conversation.id],
      teamName: snapshot?.team.title.trim() || membership?.team.title.trim()
        || conversation.title || t('kubecode.teamSession'),
      teammateCount: Math.max(0, conversationIds.length - 1),
    })
  }

  const fork = async (conversation: Conversation) => {
    try {
      const created = await api.forkConversation(conversation.id)
      onConversationCreated(created)
      trackEvent('kubecode_agent_session_forked', { agent_id: conversation.agent_id })
    } catch (cause) {
      onError(cause)
    }
  }

  return (
    <div className="kubecode-session-browser">
      <div className="kubecode-navigator-tools">
        <span>{t('kubecode.sessionsLabel')}</span>
        <SessionFilters preferences={preferences} setPreferences={setPreferences} t={t} />
      </div>
      <div className="kubecode-session-list" role="tree">
        {projectGroups.map(({ project, sessions, teams: projectTeams }) => {
          const hasQueryResults = Boolean(query.trim()) && (
            sessions.length > 0 || projectTeams.length > 0
          )
          const expanded = expandedProjectIds.includes(project.id) || hasQueryResults
          const projectConversations = conversations.filter(
            (conversation) => conversation.project_id === project.id,
          )
          const projectStatus = projectStatuses[project.id] ?? navigatorStatus(projectConversations)
          return (
            <section className="kubecode-project-tree-group" key={project.id}>
              <div
                className="kubecode-project-tree-row"
                data-active={project.id === activeProjectId}
                role="treeitem"
                aria-expanded={expanded}
              >
                <Button
                  aria-label={expanded ? t('kubecode.collapseProject') : t('kubecode.expandProject')}
                  className="kubecode-project-tree-chevron"
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => onProjectToggle(project.id)}
                >
                  {expanded ? <CaretDown /> : <CaretRight />}
                </Button>
                <Button
                  className="kubecode-project-tree-main"
                  data-active={project.id === activeProjectId}
                  data-session-status={projectStatus ?? undefined}
                  data-workspaces-enabled={project.workspaces_enabled}
                  title={project.path}
                  variant="ghost"
                  onClick={() => onProjectSelect(project.id)}
                >
                  <Folder />
                  <span>{project.name}</span>
                </Button>
                <span
                  aria-label={projectStatusLabel(projectStatus, t)}
                  className="kubecode-navigator-status"
                  data-status={projectStatus ?? undefined}
                  role="status"
                />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      aria-label={t('kubecode.projectActionsFor', { name: project.name })}
                      className="kubecode-project-tree-actions"
                      size="icon-xs"
                      variant="ghost"
                    >
                      <DotsThree />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onSelect={() => onNewSession(project.id)}>
                      <Plus /> {t('kubecode.newSession')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => onProjectWorkspacesToggle(project.id)}>
                      {project.workspaces_enabled
                        ? t('kubecode.disableWorkspaces')
                        : t('kubecode.enableWorkspaces')}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => onProjectDelete(project.id)}
                    >
                      <Trash /> {t('kubecode.delete')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {expanded && (
                <div className="kubecode-project-tree-children" role="group">
                  <Button
                    className="kubecode-project-new-session"
                    variant="ghost"
                    onClick={() => onNewSession(project.id)}
                  >
                    <Plus /> {t('kubecode.newSession')}
                  </Button>
                  {projectTeams.map((team) => (
                    <div aria-label={team.title} className="kubecode-session-team" key={team.id} role="group">
                      <div className="kubecode-session-team-header">
                        <UsersThree />
                        <span>{team.title}</span>
                        <small>{team.members.length}</small>
                      </div>
                      <div className="kubecode-session-team-tree">
                        {team.members.map(({ conversation, role }) => (
                          <SessionRow
                            activeConversationId={activeConversationId}
                            archive={archive}
                            conversation={conversation}
                            fork={fork}
                            key={conversation.id}
                            nested={role !== 'leader'}
                            onSelect={(conversationId) => {
                              if (query.trim()) {
                                trackEvent('kubecode_global_search_result_opened', {
                                  result_type: 'session',
                                })
                              }
                              onSelect(project.id, conversationId)
                            }}
                            remove={remove}
                            t={t}
                            teamRole={role}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                  {sessions.map((conversation) => (
                    <SessionRow
                      activeConversationId={activeConversationId}
                      archive={archive}
                      conversation={conversation}
                      fork={fork}
                      key={conversation.id}
                      onSelect={(conversationId) => {
                        if (query.trim()) {
                          trackEvent('kubecode_global_search_result_opened', {
                            result_type: 'session',
                          })
                        }
                        onSelect(project.id, conversationId)
                      }}
                      remove={remove}
                      t={t}
                      teamRole={conversation.team_role ?? teamByConversation.get(conversation.id)?.member.role}
                    />
                  ))}
                  {projectTeams.length === 0 && sessions.length === 0 && (
                    <div className="kubecode-empty-small">
                      {projectConversations.length
                        ? t('kubecode.noMatchingSessions')
                        : t('kubecode.noSessions')}
                    </div>
                  )}
                </div>
              )}
            </section>
          )
        })}
        {projectGroups.length === 0 && (
          <div className="kubecode-empty-small">{t('kubecode.selectProject')}</div>
        )}
      </div>
      <DeleteTeamDialog
        onConfirm={async () => {
          if (!deleteTarget) return
          if (await deleteConversation(deleteTarget.conversation, deleteTarget.conversationIds)) {
            setDeleteTarget(null)
          }
        }}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        open={Boolean(deleteTarget)}
        t={t}
        teamName={deleteTarget?.teamName ?? ''}
        teammateCount={deleteTarget?.teammateCount ?? 0}
      />
    </div>
  )
}

type TeamDeleteTarget = {
  conversation: Conversation
  conversationIds: string[]
  teamName: string
  teammateCount: number
}

type SessionRowProps = {
  activeConversationId: string | null
  archive: (conversation: Conversation) => Promise<void>
  conversation: Conversation
  fork: (conversation: Conversation) => Promise<void>
  nested?: boolean
  onSelect: (conversationId: string) => void
  remove: (conversation: Conversation) => Promise<void>
  t: Translator
  teamRole?: TeamRole | null
}

function SessionRow({
  activeConversationId,
  archive,
  conversation,
  fork,
  nested = false,
  onSelect,
  remove,
  t,
  teamRole,
}: SessionRowProps) {
  return (
    <div
      className="kubecode-session-row-shell"
      data-archived={conversation.archived}
      data-team-child={nested}
    >
      <Button
        aria-label={conversation.title || t('kubecode.untitledSession')}
        className="kubecode-session-row"
        data-active={conversation.id === activeConversationId}
        variant="ghost"
        onClick={() => onSelect(conversation.id)}
      >
        <AiAgentIcon agent={conversation.agent_id} size={18} />
        <span className="kubecode-session-row-copy">
          <span>{conversation.title || t('kubecode.untitledSession')}</span>
        </span>
        <span
          aria-label={conversation.latest_run_status
            ? runStatusLabel(conversation.latest_run_status, t)
            : undefined}
          className="kubecode-navigator-status"
          data-status={conversation.latest_run_status ?? undefined}
          role={conversation.latest_run_status ? 'status' : undefined}
        />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={t('kubecode.sessionListActions', {
              title: conversation.title || t('kubecode.untitledSession'),
            })}
            className="kubecode-session-row-actions"
            size="icon-xs"
            variant="ghost"
          >
            <DotsThree />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => void archive(conversation)}>
            <Archive />
            {conversation.archived ? t('kubecode.unarchiveSession') : t('kubecode.archiveSession')}
          </DropdownMenuItem>
          {conversation.provider_session_id && (
            <DropdownMenuItem onSelect={() => void fork(conversation)}>
              <GitFork /> {t('kubecode.forkSession')}
            </DropdownMenuItem>
          )}
          {(!teamRole || teamRole === 'leader') && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => void remove(conversation)}>
                <Trash /> {t('kubecode.delete')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

type TeamSessionGroup = {
  id: string
  projectId: string
  status: Conversation['team_status']
  title: string
  members: Array<{
    conversation: Conversation
    role: TeamRole
  }>
}

function SessionFilters({
  preferences,
  setPreferences,
  t,
}: {
  preferences: SessionListPreferences
  setPreferences: (preferences: SessionListPreferences) => void
  t: Translator
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label={t('kubecode.sessionFilters')} size="icon-xs" variant="ghost">
          <Funnel />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="kubecode-session-filter-menu">
        <DropdownMenuLabel>{t('kubecode.filterByAgent')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={preferences.agent}
          onValueChange={(value) => setPreferences({
            ...preferences,
            agent: value as SessionAgentFilter,
          })}
        >
          <DropdownMenuRadioItem value="all">{t('kubecode.allAgents')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="claude_code">Claude Code</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="codex">Codex</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="opencode">OpenCode</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t('kubecode.sortSessions')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={preferences.sort}
          onValueChange={(value) => setPreferences({ ...preferences, sort: value as SessionSort })}
        >
          <DropdownMenuRadioItem value="activity">{t('kubecode.sortByActivity')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="created">{t('kubecode.sortByCreated')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="title">{t('kubecode.sortByTitle')}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={preferences.showArchived}
          onCheckedChange={(checked) => setPreferences({ ...preferences, showArchived: checked })}
        >
          {t('kubecode.showArchivedSessions')}
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function navigatorStatus(conversations: Conversation[]): RunStatus | null {
  const statuses = conversations.map((conversation) => conversation.latest_run_status)
  if (statuses.includes('waiting_permission')) return 'waiting_permission'
  if (statuses.some((status) => (
    status === 'failed' || status === 'timed_out' || status === 'interrupted'
  ))) return 'failed'
  return statuses.includes('running') ? 'running' : null
}

function projectStatusLabel(
  status: RunStatus | 'stuck' | null,
  t: Translator,
): string | undefined {
  if (status === 'stuck') return t('kubecode.permissionRequired')
  return status ? runStatusLabel(status, t) : undefined
}

function runStatusLabel(status: RunStatus, t: Translator): string {
  if (status === 'running') return t('kubecode.running')
  if (status === 'waiting_permission') return t('kubecode.permissionRequired')
  if (status === 'completed') return t('kubecode.ready')
  return t('kubecode.error')
}
