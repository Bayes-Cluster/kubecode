import { useEffect, useMemo, useState } from 'react'
import {
  Archive,
  DotsThree,
  Funnel,
  GitFork,
  MagnifyingGlass,
  Trash,
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

import type { Conversation, KubecodeApi } from './api'
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
}: SessionSidebarListProps) {
  const [preferences, setPreferences] = useState<SessionListPreferences>(() => (
    readSessionListPreferences(localStorage)
  ))
  const sections = useMemo(
    () => buildSessionSections(conversations, preferences),
    [conversations, preferences],
  )

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

  const remove = async (conversation: Conversation) => {
    try {
      await api.removeConversation(conversation.id)
      onConversationRemoved(conversation.id)
      trackEvent('kubecode_session_removed', { agent_id: conversation.agent_id, scope: 'local' })
    } catch (cause) {
      onError(cause)
    }
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
        {sections.map((section) => (
          <section className="kubecode-session-section" key={section.id}>
            <header>
              <span>{sectionLabel(t, section.id)}</span>
              <small>{section.sessions.length}</small>
            </header>
            {section.sessions.map((conversation) => (
              <div className="kubecode-session-row-shell" data-archived={conversation.archived} key={conversation.id}>
                <Button
                  aria-label={conversation.title || t('kubecode.untitledSession')}
                  className="kubecode-session-row"
                  data-active={conversation.id === activeConversationId}
                  variant={conversation.id === activeConversationId ? 'secondary' : 'ghost'}
                  onClick={() => onSelect(conversation.id)}
                >
                  <span className="kubecode-session-agent-status" data-status={conversation.latest_run_status ?? undefined}>
                    <AiAgentIcon agent={conversation.agent_id} size={18} />
                  </span>
                  <span>{conversation.title || t('kubecode.untitledSession')}</span>
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
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => void remove(conversation)}>
                      <Trash /> {t('kubecode.delete')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))}
          </section>
        ))}
        {sections.length === 0 && (
          <div className="kubecode-empty-small">
            {conversations.length ? t('kubecode.noMatchingSessions') : t('kubecode.noSessions')}
          </div>
        )}
      </div>
    </div>
  )
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
