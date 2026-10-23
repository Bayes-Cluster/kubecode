import type { CSSProperties, ReactNode, RefObject } from 'react'
import { ChevronRight, Plus, Search, Settings } from 'lucide-react'

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Kbd } from '@/components/ui/kbd'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
} from '@/components/ui/sidebar'
import { IconButton } from '@/components/workspace/IconButton'
import { cn } from '@/lib/utils'

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
    <Sidebar
        className="kubecode-session-sidebar"
        collapsible="none"
        style={navigatorWidth === undefined
          ? { width: '100%' }
          : { '--sidebar-width': `${navigatorWidth}px`, width: navigatorWidth } as CSSProperties}
      >
        <nav aria-label={t('kubecode.nav.workspaces')} className="flex min-h-0 flex-1 flex-col">
          {/* In the phone Sheet the header leaves room for the Sheet's close button. */}
          <SidebarHeader className={cn('flex-row items-center justify-between', navigatorWidth === undefined && 'pr-12')}>
            <h2 className="truncate px-2 text-sm font-semibold">{t('kubecode.nav.workspaces')}</h2>
            <div className="flex items-center">
              <IconButton icon={<Plus aria-hidden="true" />} label={t('kubecode.addProject')} onClick={onAddProject} />
              <IconButton icon={<Settings aria-hidden="true" />} label={t('kubecode.settings')} onClick={onOpenSettings} />
            </div>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
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
            </SidebarGroup>
            {workspaceSection}
            <Collapsible
              className="group/collapsible"
              open={historyOpen}
              onOpenChange={(open) => {
                // While it holds what is on screen, it stays open.
                if (!open && historyPinned) return
                onHistoryOpenChange(open)
              }}
            >
              <SidebarGroup>
                <SidebarGroupLabel asChild>
                  <CollapsibleTrigger className="w-full">
                    {t('kubecode.nav.history')}
                    <ChevronRight
                      aria-hidden="true"
                      className="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-90"
                    />
                  </CollapsibleTrigger>
                </SidebarGroupLabel>
                <CollapsibleContent>
                  <SidebarGroupContent className="flex flex-col gap-2">
                    <InputGroup>
                      <InputGroupAddon>
                        <Search aria-hidden="true" />
                      </InputGroupAddon>
                      <InputGroupInput
                        // It finds Sessions of every Workspace, not only this one, and says so.
                        aria-label={t('kubecode.searchSessionsAllWorkspaces')}
                        placeholder={t('kubecode.searchSessionsAllWorkspaces')}
                        ref={searchRef}
                        spellCheck={false}
                        value={query}
                        onChange={(event) => onQueryChange(event.target.value)}
                      />
                      <InputGroupAddon align="inline-end">
                        <Kbd>⌘K</Kbd>
                      </InputGroupAddon>
                    </InputGroup>
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
                  </SidebarGroupContent>
                </CollapsibleContent>
              </SidebarGroup>
            </Collapsible>
          </SidebarContent>
        </nav>
    </Sidebar>
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
