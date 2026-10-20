import { Ellipsis, Folder, Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { Translator } from '@/lib/i18n'

import type { Conversation, Project } from '../api'
import { projectStatusLabel, sessionsRunState } from '../runStatusLabels'

export type WorkspaceListProps = {
  activeProjectId: string | null
  /** Every Project's Sessions, for a run state before the Project's runs are read. */
  conversations: readonly Conversation[]
  projects: readonly Project[]
  /** Each Project's run state from its runs; absent while they are unread. */
  projectStatuses: Record<string, 'running' | 'stuck' | null>
  t: Translator
  onNewSession: (projectId: string) => void
  onProjectDelete: (projectId: string) => void
  onProjectWorkspacesToggle: (projectId: string) => void
  onWorkspaceSelect: (projectId: string) => void
}

/**
 * The Workspaces, one row per registered Project (ADR 0228 §1): its name is
 * the row's whole accessible name, its run state is in words, and its actions
 * are one menu away. Choosing a row enters that Workspace at the place it was
 * left in; there is nothing to expand.
 */
export function WorkspaceList({
  activeProjectId,
  conversations,
  projects,
  projectStatuses,
  t,
  onNewSession,
  onProjectDelete,
  onProjectWorkspacesToggle,
  onWorkspaceSelect,
}: WorkspaceListProps) {
  if (projects.length === 0) {
    return <p className="kubecode-empty-small">{t('kubecode.selectProject')}</p>
  }
  return (
    <ul aria-label={t('kubecode.nav.workspaces')} className="kubecode-workspace-list">
      {projects.map((project) => {
        const active = project.id === activeProjectId
        const status = projectStatuses[project.id]
          ?? sessionsRunState(conversations.filter((conversation) => conversation.project_id === project.id))
        return (
          <li className="kubecode-workspace-row" data-active={active} key={project.id}>
            <Button
              aria-current={active ? 'true' : undefined}
              className="kubecode-workspace-row-main"
              data-active={active}
              data-session-status={status ?? undefined}
              data-workspaces-enabled={project.workspaces_enabled}
              title={project.name}
              variant="ghost"
              onClick={() => onWorkspaceSelect(project.id)}
            >
              <Folder size={16} />
              <span>{project.name}</span>
            </Button>
            <span
              aria-label={projectStatusLabel(status, t)}
              className="kubecode-navigator-status"
              data-status={status ?? undefined}
              role="status"
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label={t('kubecode.projectActionsFor', { name: project.name })}
                  className="kubecode-workspace-row-actions"
                  size="icon-xs"
                  variant="ghost"
                >
                  <Ellipsis size={16} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onSelect={() => onNewSession(project.id)}>
                  <Plus size={16} /> {t('kubecode.newSession')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onProjectWorkspacesToggle(project.id)}>
                  {project.workspaces_enabled
                    ? t('kubecode.disableWorkspaces')
                    : t('kubecode.enableWorkspaces')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => onProjectDelete(project.id)}>
                  <Trash2 size={16} /> {t('kubecode.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        )
      })}
    </ul>
  )
}
