import { useEffect, useMemo, useState } from 'react'
import {
  Archive,
  DotsThree,
  Funnel,
  GitFork,
  MagnifyingGlass,
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
import { Input } from '@/components/ui/input'
import { createTranslator } from '@/lib/i18n'
import { trackEvent } from '@/lib/telemetry'

import type { Conversation, KubecodeApi, TeamSnapshot } from './api'
import { DeleteTeamDialog } from './DeleteTeamDialog'
import {
  buildSessionSections,
  readSessionListPreferences,
  writeSessionListPreferences,
  type SessionAgentFilter,
  type SessionListPreferences,
  type SessionSectionId,
  type SessionSort,
} from './sessionList'

type Translator = ReturnType<typeof createTranslator>

type SessionSidebarListProps = {
  activeConversationId: string | null
  api: KubecodeApi
  conversations: Conversation[]
  onConversationCreated: (conversation: Conversation) => void
  onConversationRemoved: (conversationId: string) => void
  onConversationUpdated: (conversation: Conversation) => void
  onError: (cause: unknown) => void
  onSelect: (conversationId: string) => void
  t: Translator
  teams?: TeamSnapshot[]
}

export function SessionSidebarList({
  activeConversationId,
  api,
  conversations,
  onConversationCreated,
  onConversationRemoved,
  onConversationUpdated,
  onError,
  onSelect,
  t,
  teams = [],
}: SessionSidebarListProps) {
  const [preferences, setPreferences] = useState<SessionListPreferences>(() => (
    readSessionListPreferences(localStorage)
  ))
  const [deleteTarget, setDeleteTarget] = useState<TeamDeleteTarget | null>(null)
  const visibleSections = useMemo(
    () => buildSessionSections(conversations, preferences),
    [conversations, preferences],
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
      preferences,
    ),
    [conversations, preferences, teamConversationIds],
  )
  const teamGroups = useMemo(() => {
    const grouped = new Map<string, TeamSessionGroup>()
    for (const snapshot of teams) {
      grouped.set(snapshot.team.id, {
        id: snapshot.team.id,
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
      const group = grouped.get(teamId) ?? { id: teamId, title: '', members: [] }
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
      <div className="kubecode-session-search">
        <MagnifyingGlass />
        <Input
          aria-label={t('kubecode.searchSessions')}
          placeholder={t('kubecode.searchSessions')}
          role="searchbox"
          value={preferences.query}
          onChange={(event) => setPreferences({ ...preferences, query: event.target.value })}
        />
        <SessionFilters preferences={preferences} setPreferences={setPreferences} t={t} />
      </div>
      <div className="kubecode-session-list">
        {teamGroups.map((team) => (
          <section
            aria-label={team.title}
            className="kubecode-session-team"
            key={team.id}
            role="group"
          >
            <header className="kubecode-session-team-header">
              <UsersThree />
              <span>{team.title}</span>
              <small>{team.members.length}</small>
            </header>
            <div className="kubecode-session-team-tree">
              {team.members.map(({ conversation, role }) => (
                <SessionRow
                  activeConversationId={activeConversationId}
                  archive={archive}
                  conversation={conversation}
                  conversationsById={conversationsById}
                  fork={fork}
                  key={conversation.id}
                  nested={role === 'teammate'}
                  onSelect={onSelect}
                  remove={remove}
                  t={t}
                  teamRole={role}
                />
              ))}
            </div>
          </section>
        ))}
        {sections.map((section) => (
          <section className="kubecode-session-section" key={section.id}>
            <header>
              <span>{sectionLabel(t, section.id)}</span>
              <small>{section.sessions.length}</small>
            </header>
            {section.sessions.map((conversation) => (
              <SessionRow
                activeConversationId={activeConversationId}
                archive={archive}
                conversation={conversation}
                conversationsById={conversationsById}
                fork={fork}
                key={conversation.id}
                onSelect={onSelect}
                remove={remove}
                t={t}
                teamRole={conversation.team_role ?? teamByConversation.get(conversation.id)?.member.role}
              />
            ))}
          </section>
        ))}
        {teamGroups.length === 0 && sections.length === 0 && (
          <div className="kubecode-empty-small">
            {conversations.length ? t('kubecode.noMatchingSessions') : t('kubecode.noSessions')}
          </div>
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
  conversationsById: Map<string, Conversation>
  fork: (conversation: Conversation) => Promise<void>
  nested?: boolean
  onSelect: (conversationId: string) => void
  remove: (conversation: Conversation) => Promise<void>
  t: Translator
  teamRole?: 'leader' | 'teammate' | null
}

function SessionRow({
  activeConversationId,
  archive,
  conversation,
  conversationsById,
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
        <span className="kubecode-session-agent-status" data-status={conversation.latest_run_status ?? undefined}>
          <AiAgentIcon agent={conversation.agent_id} size={18} />
        </span>
        <span className="kubecode-session-row-copy">
          <span>{conversation.title || t('kubecode.untitledSession')}</span>
          {teamRole && (
            <small>
              <GitFork />
              {teamRole === 'leader'
                ? t('kubecode.teamLeader')
                : t('kubecode.teamTeammate')}
            </small>
          )}
          {conversation.relationship && (
            <small>
              <GitFork />
              {relationshipLabel(conversation, conversationsById, t)}
            </small>
          )}
        </span>
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
          {teamRole !== 'teammate' && (
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
  title: string
  members: Array<{
    conversation: Conversation
    role: 'leader' | 'teammate'
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

function sectionLabel(t: Translator, section: SessionSectionId): string {
  return t(`kubecode.sessions.${section}`)
}

function relationshipLabel(
  conversation: Conversation,
  conversationsById: Map<string, Conversation>,
  t: Translator,
): string {
  const parent = conversation.parent_conversation_id
    ? conversationsById.get(conversation.parent_conversation_id)
    : null
  const parentTitle = parent?.title || t('kubecode.untitledSession')
  if (conversation.relationship === 'subagent') {
    return t('kubecode.subagentOf', { title: parentTitle })
  }
  if (conversation.relationship === 'team_member') {
    return t('kubecode.teamMemberOf', { title: parentTitle })
  }
  return conversation.relationship === 'branch'
    ? t('kubecode.branchOf', { title: parentTitle })
    : t('kubecode.forkOf', { title: parentTitle })
}
