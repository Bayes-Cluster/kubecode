import type { ReactNode, RefObject } from 'react'
import { CircleHelp, Plus, Search, Settings } from 'lucide-react'

import { ResizeHandle } from '@/components/ResizeHandle'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

import type { AgentRun, Conversation, KubecodeApi, Project, RunStatus, TeamSnapshot } from '../api'
import { SessionSidebarList } from '../SessionSidebarList'
import type { WeChatBinding } from './useWeChatBinding'
import { WorkspaceList } from './WorkspaceList'
import type { Translator } from '@/lib/i18n'

export type ProjectNavigatorProps = {
  activeConversationId: string | null
  activeProjectId: string | null
  api: KubecodeApi
  conversations: Conversation[]
  /** Whether "History and execution" is open. */
  historyOpen: boolean
  /**
   * It holds what is on screen (a Session, a question, a Thread) or the search
   * has text: it stays open, and closing it is not offered.
   */
  historyPinned?: boolean
  /** The active Workspace's legacy Threads and research questions, inside execution history. */
  historySection?: ReactNode
  /** The width beside the view; absent inside the phone sheet, which sizes it. */
  navigatorWidth?: number
  onAddProject: () => void
  onConversationCreated: (conversation: Conversation) => void
  onConversationRemoved: (conversationId: string) => void
  onConversationUpdated: (conversation: Conversation) => void
  onError: (cause: unknown) => void
  onHistoryOpenChange: (open: boolean) => void
  onNewSession: (projectId: string) => void
  onOpenSettings: () => void
  onProjectDelete: (projectId: string) => void
  onProjectWorkspacesToggle: (projectId: string) => void
  onQueryChange: (query: string) => void
  onResize: (delta: number) => void
  onSelect: (projectId: string, conversationId: string) => void
  onWorkspaceSelect: (projectId: string) => void
  projects: Project[]
  projectRuns: Record<string, AgentRun[]>
  /** The Session search, across every Workspace. */
  query: string
  searchRef: RefObject<HTMLInputElement | null>
  t: Translator
  teams: TeamSnapshot[]
  wechat?: WeChatBinding
  /** The active Workspace's places, members, and private conversations. */
  workspaceSection?: ReactNode
}

/**
 * The one navigation hierarchy (ADR 0228 §1): the Workspaces, the active
 * Workspace's places, and, collapsed below them, its execution history with
 * the Session search, its Sessions and Teams, and the older Threads and
 * research questions.
 */
export function ProjectNavigator({
  activeConversationId,
  activeProjectId,
  api,
  conversations,
  historyOpen,
  historyPinned = false,
  historySection,
  navigatorWidth,
  onAddProject,
  onConversationCreated,
  onConversationRemoved,
  onConversationUpdated,
  onError,
  onHistoryOpenChange,
  onNewSession,
  onOpenSettings,
  onProjectDelete,
  onProjectWorkspacesToggle,
  onQueryChange,
  onResize,
  onSelect,
  onWorkspaceSelect,
  projects,
  projectRuns,
  query,
  searchRef,
  t,
  teams,
  wechat,
  workspaceSection,
}: ProjectNavigatorProps) {
  const projectStatuses = Object.fromEntries(projects.map((item) => [
    item.id,
    projectSessionStatus(projectRuns[item.id] ?? []),
  ]))

  return (
    <>
      <nav
        aria-label={t('kubecode.nav.workspaces')}
        className="kubecode-session-sidebar"
        style={navigatorWidth === undefined ? undefined : { width: navigatorWidth }}
      >
        <div className="kubecode-navigator-heading">
          <strong>{t('kubecode.nav.workspaces')}</strong>
          <div>
            <Button aria-label={t('kubecode.addProject')} size="icon-xs" variant="ghost" onClick={onAddProject}><Plus  size={16}/></Button>
            <Button aria-label={t('kubecode.settings')} size="icon-xs" variant="ghost" onClick={onOpenSettings}><Settings  size={16}/></Button>
            <Button aria-label={t('kubecode.help')} size="icon-xs" variant="ghost"><CircleHelp  size={16}/></Button>
          </div>
        </div>
        <div className="kubecode-navigator-body">
          <WorkspaceList
            activeProjectId={activeProjectId}
            conversations={conversations}
            projects={projects}
            projectStatuses={projectStatuses}
            t={t}
            onNewSession={onNewSession}
            onProjectDelete={onProjectDelete}
            onProjectWorkspacesToggle={onProjectWorkspacesToggle}
            onWorkspaceSelect={onWorkspaceSelect}
          />
          {workspaceSection}
          <details
            className="kubecode-history-nav"
            open={historyOpen}
            onToggle={(event) => {
              const open = event.currentTarget.open
              if (!open && historyPinned) {
                event.currentTarget.open = true
                return
              }
              if (open !== historyOpen) onHistoryOpenChange(open)
            }}
          >
            <summary>{t('kubecode.nav.history')}</summary>
            <div className="kubecode-history-search">
              <Search aria-hidden="true" size={16} />
              <Input
                // It finds Sessions of every Workspace, not only this one, and says so.
                aria-label={t('kubecode.searchSessionsAllWorkspaces')}
                placeholder={t('kubecode.searchSessionsAllWorkspaces')}
                ref={searchRef}
                spellCheck={false}
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
              />
              <kbd>⌘K</kbd>
            </div>
            <SessionSidebarList
              activeConversationId={activeConversationId}
              api={api}
              conversations={conversations}
              onConversationCreated={onConversationCreated}
              onConversationRemoved={onConversationRemoved}
              onConversationUpdated={onConversationUpdated}
              onError={onError}
              onNewSession={onNewSession}
              onSelect={onSelect}
              projects={projects}
              query={query}
              scopeProjectId={activeProjectId}
              t={t}
              teams={teams}
              wechat={wechat}
            />
            {historySection}
          </details>
        </div>
      </nav>
      {navigatorWidth !== undefined && <ResizeHandle onResize={onResize} />}
    </>
  )
}

type ProjectSessionStatus = 'running' | 'stuck'

function projectSessionStatus(runs: AgentRun[]): ProjectSessionStatus | null {
  const latestRuns = new Map<string, AgentRun>()
  for (const run of runs) latestRuns.set(run.conversation_id, run)
  const statuses = [...latestRuns.values()].map((run) => run.status)
  if (statuses.some(isStuckStatus)) return 'stuck'
  return statuses.includes('running') ? 'running' : null
}

function isStuckStatus(status: RunStatus): boolean {
  return status === 'waiting_permission'
    || status === 'failed'
    || status === 'timed_out'
    || status === 'interrupted'
}
