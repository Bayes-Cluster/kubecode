import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { RiWechatLine } from '@remixicon/react'
import {
  Archive,
  Ellipsis,
  Filter,
  GitFork,
  Plus,
  Trash2,
  Users
} from 'lucide-react'

import { AiAgentIcon } from '@/components/AiAgentIcon'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty'
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '@/components/ui/sidebar'
import type { Translator } from '@/lib/i18n'
import { trackEvent } from '@/lib/telemetry'

import { Icon } from './icons'
import { RUN_STATUS_ICONS } from './icons/statusIcons'

import type { Conversation, KubecodeApi, Project, TeamRole, TeamSnapshot } from './api'
import { DeleteTeamDialog } from './DeleteTeamDialog'
import { runStatusLabel } from './runStatusLabels'
import { wechatUnbindableReason, type WeChatBinding } from './app/useWeChatBinding'
import {
  buildSessionSections,
  readSessionListPreferences,
  writeSessionListPreferences,
  type SessionAgentFilter,
  type SessionListPreferences,
  type SessionSort,
} from './sessionList'

type SessionSidebarListProps = {
  activeConversationId: string | null
  api: KubecodeApi
  conversations: Conversation[]
  onConversationCreated: (conversation: Conversation) => void
  onConversationRemoved: (conversationId: string) => void
  onConversationUpdated: (conversation: Conversation) => void
  onError: (cause: unknown) => void
  onNewSession: (projectId: string) => void
  onSelect: (projectId: string, conversationId: string) => void
  /** Every registered Project, to name the groups of a search. */
  projects: Project[]
  /**
   * The Workspace whose execution history is listed. A search lists the
   * matches of every Workspace instead, under plain headings.
   */
  scopeProjectId: string | null
  query?: string
  t: Translator
  teams?: TeamSnapshot[]
  /** The single active WeChat Session (issue #135), when available. */
  wechat?: WeChatBinding
}

/**
 * Execution history (ADR 0228 §1): one Workspace's Sessions and Teams, or,
 * while searching, the matching Sessions of every Workspace grouped under
 * their Project's name. It never renders a control named after a Project, so
 * the Workspace rows stay the only ones.
 */
export function SessionSidebarList({
  activeConversationId,
  api,
  conversations,
  onConversationCreated,
  onConversationRemoved,
  onConversationUpdated,
  onError,
  onNewSession,
  onSelect,
  projects,
  query = '',
  scopeProjectId,
  t,
  teams = [],
  wechat,
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
  const searching = Boolean(query.trim())
  const projectGroups = useMemo(() => {
    const visibleSoloSessions = sections.flatMap((section) => section.sessions)
    return projects
      .filter((project) => searching || project.id === scopeProjectId)
      .map((project) => ({
        project,
        sessions: visibleSoloSessions.filter((conversation) => conversation.project_id === project.id),
        teams: teamGroups.filter((team) => team.projectId === project.id),
      }))
      .filter((group) => !searching || group.sessions.length > 0 || group.teams.length > 0)
  }, [projects, scopeProjectId, searching, sections, teamGroups])

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
    <SidebarGroup aria-label={t('kubecode.sessionsLabel')} className="p-0" role="region">
      <SidebarGroupLabel>{t('kubecode.sessionsLabel')}</SidebarGroupLabel>
      <SessionFilters preferences={preferences} setPreferences={setPreferences} t={t} />
      <SidebarGroupContent className="flex flex-col gap-2">
        {projectGroups.map(({ project, sessions, teams: projectTeams }) => {
          const projectConversations = conversations.filter(
            (conversation) => conversation.project_id === project.id,
          )
          const open = (conversationId: string) => {
            if (searching) {
              trackEvent('kubecode_global_search_result_opened', { result_type: 'session' })
            }
            onSelect(project.id, conversationId)
          }
          const row = (conversation: Conversation, teamRole: TeamRole | null | undefined, nested = false) => (
            <SessionRow
              activeConversationId={activeConversationId}
              archive={archive}
              conversation={conversation}
              fork={fork}
              key={conversation.id}
              nested={nested}
              onSelect={open}
              remove={remove}
              t={t}
              teamRole={teamRole}
              wechat={wechat}
            />
          )
          return (
            <section aria-label={searching ? project.name : undefined} key={project.id}>
              {searching && (
                <SidebarGroupLabel asChild>
                  <h3>{project.name}</h3>
                </SidebarGroupLabel>
              )}
              <SidebarMenu>
                {!searching && (
                  <SidebarMenuItem>
                    <SidebarMenuButton className="pointer-coarse:min-h-(--ws-touch-target)" onClick={() => onNewSession(project.id)}>
                      <Plus aria-hidden="true" />
                      <span>{t('kubecode.newSession')}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {projectTeams.map((team) => {
                  const leaders = team.members.filter((member) => member.role === 'leader')
                  const teammates = team.members.filter((member) => member.role !== 'leader')
                  return (
                    <SidebarMenuItem aria-label={team.title} key={team.id} role="group">
                      <div className="flex h-8 min-w-0 items-center gap-2 px-2 text-sm font-medium">
                        <Users aria-hidden="true" className="shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{team.title}</span>
                        <Badge variant="secondary">{team.members.length}</Badge>
                      </div>
                      {leaders.length > 0 && (
                        <SidebarMenu>{leaders.map(({ conversation, role }) => row(conversation, role))}</SidebarMenu>
                      )}
                      {teammates.length > 0 && (
                        <SidebarMenuSub>{teammates.map(({ conversation, role }) => row(conversation, role, true))}</SidebarMenuSub>
                      )}
                    </SidebarMenuItem>
                  )
                })}
                {sessions.map((conversation) => row(
                  conversation,
                  conversation.team_role ?? teamByConversation.get(conversation.id)?.member.role,
                ))}
              </SidebarMenu>
              {!searching && projectTeams.length === 0 && sessions.length === 0 && (
                <SidebarEmpty>
                  {projectConversations.length
                    ? t('kubecode.noMatchingSessions')
                    : t('kubecode.noSessions')}
                </SidebarEmpty>
              )}
            </section>
          )
        })}
        {projectGroups.length === 0 && (
          <SidebarEmpty>
            {searching ? t('kubecode.noMatchingSessions') : t('kubecode.selectProject')}
          </SidebarEmpty>
        )}
      </SidebarGroupContent>
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
    </SidebarGroup>
  )
}

/** An empty execution history: the official Empty, compact for the navigation. */
function SidebarEmpty({ children }: { children: ReactNode }) {
  return (
    <Empty className="p-4">
      <EmptyHeader>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
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
  wechat?: WeChatBinding
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
  wechat,
}: SessionRowProps) {
  const title = conversation.title || t('kubecode.untitledSession')
  const wechatBound = Boolean(wechat?.linked && wechat.boundConversationId === conversation.id)
  const unbindable = wechatUnbindableReason(conversation)
  const label = wechatBound ? `${title}, ${t('kubecode.wechat.activeSessionMarker')}` : title
  const active = conversation.id === activeConversationId
  const content = (
    <>
      <AiAgentIcon agent={conversation.agent_id} size={18} />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {wechatBound && (
        <Icon
          className="kubecode-session-wechat-marker"
          role="status"
          size="secondary"
          source={RiWechatLine}
        />
      )}
      {conversation.latest_run_status && (
        <>
          <Icon
            role="status"
            size="secondary"
            source={RUN_STATUS_ICONS[conversation.latest_run_status].Icon}
          />
          <span aria-label={runStatusLabel(conversation.latest_run_status, t)} className="sr-only" role="status" />
        </>
      )}
    </>
  )
  const actions = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuAction
          aria-label={t('kubecode.sessionListActions', { title })}
          showOnHover={!nested}
        >
          <Ellipsis aria-hidden="true" />
        </SidebarMenuAction>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={() => void archive(conversation)}>
            <Archive aria-hidden="true" />
            {conversation.archived ? t('kubecode.unarchiveSession') : t('kubecode.archiveSession')}
          </DropdownMenuItem>
          {conversation.provider_session_id && (
            <DropdownMenuItem onSelect={() => void fork(conversation)}>
              <GitFork aria-hidden="true" /> {t('kubecode.forkSession')}
            </DropdownMenuItem>
          )}
          {wechat?.linked && (wechatBound ? (
            <DropdownMenuItem
              onSelect={() => {
                trackEvent('kubecode_wechat_session_binding_changed', { action: 'unbind', source: 'sidebar' })
                void wechat.unbind()
              }}
            >
              <RiWechatLine aria-hidden="true" /> {t('kubecode.wechat.stopUsingForWeChat')}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              disabled={Boolean(unbindable) || wechat.pending}
              onSelect={() => {
                trackEvent('kubecode_wechat_session_binding_changed', { action: 'bind', source: 'sidebar' })
                void wechat.bind(conversation.id)
              }}
            >
              <RiWechatLine aria-hidden="true" />
              {unbindable
                ? t('kubecode.wechat.useForWeChatUnavailable', {
                  reason: t(`kubecode.wechat.unbindable.${unbindable}`),
                })
                : t('kubecode.wechat.useForWeChat')}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        {(!teamRole || teamRole === 'leader') && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => void remove(conversation)}>
              <Trash2 aria-hidden="true" /> {t('kubecode.delete')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
  // A teammate sits under its Leader, in the official sub-menu.
  if (nested) {
    return (
      <SidebarMenuSubItem data-archived={conversation.archived}>
        <SidebarMenuSubButton asChild className="pointer-coarse:min-h-(--ws-touch-target) pr-8" isActive={active}>
          <button aria-label={label} type="button" onClick={() => onSelect(conversation.id)}>
            {content}
          </button>
        </SidebarMenuSubButton>
        {actions}
      </SidebarMenuSubItem>
    )
  }
  return (
    <SidebarMenuItem data-archived={conversation.archived}>
      <SidebarMenuButton className="pointer-coarse:min-h-(--ws-touch-target)" aria-label={label} isActive={active} onClick={() => onSelect(conversation.id)}>
        {content}
      </SidebarMenuButton>
      {actions}
    </SidebarMenuItem>
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
        <SidebarGroupAction aria-label={t('kubecode.sessionFilters')} title={t('kubecode.sessionFilters')}>
          <Filter aria-hidden="true" />
        </SidebarGroupAction>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
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
