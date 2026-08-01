import { Gear, Plus, Question } from '@phosphor-icons/react'

import { ResizeHandle } from '@/components/ResizeHandle'
import { Button } from '@/components/ui/button'

import type { AgentRun, Conversation, KubecodeApi, Project, RunStatus, TeamSnapshot } from '../api'
import { SessionSidebarList } from '../SessionSidebarList'
import type { Translator } from './translator'

export type ProjectNavigatorProps = {
  activeConversationId: string | null
  activeProjectId: string | null
  api: KubecodeApi
  conversations: Conversation[]
  expandedProjectIds: string[]
  navigatorWidth: number
  onAddProject: () => void
  onConversationCreated: (conversation: Conversation) => void
  onConversationRemoved: (conversationId: string) => void
  onConversationUpdated: (conversation: Conversation) => void
  onError: (message: string) => void
  onNewSession: (projectId: string) => void
  onOpenSettings: () => void
  onProjectDelete: (projectId: string) => void
  onProjectSelect: (projectId: string) => void
  onProjectToggle: (projectId: string) => void
  onProjectWorkspacesToggle: (projectId: string) => void
  onResize: (delta: number) => void
  onSelect: (projectId: string, conversationId: string) => void
  projects: Project[]
  projectRuns: Record<string, AgentRun[]>
  query: string
  t: Translator
  teams: TeamSnapshot[]
}

export function ProjectNavigator({
  activeConversationId,
  activeProjectId,
  api,
  conversations,
  expandedProjectIds,
  navigatorWidth,
  onAddProject,
  onConversationCreated,
  onConversationRemoved,
  onConversationUpdated,
  onError,
  onNewSession,
  onOpenSettings,
  onProjectDelete,
  onProjectSelect,
  onProjectToggle,
  onProjectWorkspacesToggle,
  onResize,
  onSelect,
  projects,
  projectRuns,
  query,
  t,
  teams,
}: ProjectNavigatorProps) {
  const projectStatuses = Object.fromEntries(projects.map((item) => [
    item.id,
    projectSessionStatus(projectRuns[item.id] ?? []),
  ]))

  return (
    <>
      <nav
        aria-label={t('kubecode.projects')}
        className="kubecode-session-sidebar"
        style={{ width: navigatorWidth }}
      >
        <div className="kubecode-navigator-heading">
          <strong>{t('kubecode.projects')}</strong>
          <div>
            <Button aria-label={t('kubecode.addProject')} size="icon-xs" variant="ghost" onClick={onAddProject}><Plus /></Button>
            <Button aria-label={t('kubecode.settings')} size="icon-xs" variant="ghost" onClick={onOpenSettings}><Gear /></Button>
            <Button aria-label={t('kubecode.help')} size="icon-xs" variant="ghost"><Question /></Button>
          </div>
        </div>
        <SessionSidebarList
          activeConversationId={activeConversationId}
          activeProjectId={activeProjectId}
          api={api}
          conversations={conversations}
          expandedProjectIds={expandedProjectIds}
          onConversationCreated={onConversationCreated}
          onConversationRemoved={onConversationRemoved}
          onConversationUpdated={onConversationUpdated}
          onError={onError}
          onNewSession={onNewSession}
          onProjectDelete={onProjectDelete}
          onProjectSelect={onProjectSelect}
          onProjectToggle={onProjectToggle}
          onProjectWorkspacesToggle={onProjectWorkspacesToggle}
          onSelect={onSelect}
          projects={projects}
          projectStatuses={projectStatuses}
          query={query}
          t={t}
          teams={teams}
        />
      </nav>
      <ResizeHandle onResize={onResize} />
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
