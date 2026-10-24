import { Ellipsis, Folder, Plus, Trash2 } from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty'
import {
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import type { Translator } from '@/lib/i18n'
import { cn } from '@/lib/utils'

import type { Conversation, Project } from '../api'
import { projectStatusLabel, sessionsRunState } from '../runStatusLabels'
import { useSidebarMenuSize } from './useSidebarMenuSize'

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

/** A dot beside the words: the run state is read from its label, never this colour alone. */
const STATUS_DOT: Partial<Record<string, string>> = {
  running: 'bg-info-foreground',
  stuck: 'bg-warning-foreground',
  waiting_permission: 'bg-warning-foreground',
  failed: 'bg-destructive',
  timed_out: 'bg-destructive',
  interrupted: 'bg-destructive',
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
  const menuSize = useSidebarMenuSize()
  if (projects.length === 0) {
    return (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyDescription>{t('kubecode.selectProject')}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  const rows = projects.map((project) => {
    const status = projectStatuses[project.id]
      ?? sessionsRunState(conversations.filter((conversation) => conversation.project_id === project.id))
    return { project, status, label: projectStatusLabel(status, t) }
  })
  return (
    <>
      <SidebarMenu aria-label={t('kubecode.nav.workspaces')}>
        {rows.map(({ label, project, status }) => {
          const active = project.id === activeProjectId
          return (
            <SidebarMenuItem key={project.id}>
              <SidebarMenuButton
               
                aria-current={active ? 'true' : undefined}
                data-session-status={status ?? undefined}
                data-workspaces-enabled={project.workspaces_enabled}
                isActive={active}
                size={menuSize}
                title={project.name}
                onClick={() => onWorkspaceSelect(project.id)}
              >
                <Folder aria-hidden="true" />
                <span>{project.name}</span>
              </SidebarMenuButton>
              {label && (
                <SidebarMenuBadge className="right-7">
                  <span
                    aria-label={label}
                    className={cn('size-2 rounded-full', STATUS_DOT[status ?? 'running'] ?? 'bg-warning-foreground')}
                    role="img"
                  />
                </SidebarMenuBadge>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuAction
                    aria-label={t('kubecode.projectActionsFor', { name: project.name })}
                   
                    showOnHover
                  >
                    <Ellipsis aria-hidden="true" />
                  </SidebarMenuAction>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuGroup>
                    <DropdownMenuItem onSelect={() => onNewSession(project.id)}>
                      <Plus aria-hidden="true" /> {t('kubecode.newSession')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => onProjectWorkspacesToggle(project.id)}>
                      {project.workspaces_enabled
                        ? t('kubecode.disableWorkspaces')
                        : t('kubecode.enableWorkspaces')}
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => onProjectDelete(project.id)}>
                    <Trash2 aria-hidden="true" /> {t('kubecode.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          )
        })}
      </SidebarMenu>
      {/* One live region for the list: each Workspace's run state, so a change is announced once. */}
      <p className="sr-only" role="status">
        {rows.filter((row) => row.label).map(({ label, project }) => (
          <span key={project.id}>{t('kubecode.nav.workspaceStatus', { workspace: project.name, status: label ?? '' })} </span>
        ))}
      </p>
    </>
  )
}
