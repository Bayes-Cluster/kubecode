import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { SidebarProvider } from '@/components/ui/sidebar'
import { createTranslator } from '@/lib/i18n'

import type { Conversation, Project } from '../api'
import { WorkspaceList, type WorkspaceListProps } from './WorkspaceList'

const t = createTranslator('en')

const projects: Project[] = [
  { id: 'project-1', name: 'Demo', path: '/demo', workspaces_enabled: false },
  { id: 'project-2', name: 'Other', path: '/other', workspaces_enabled: true },
]

function list(overrides: Partial<WorkspaceListProps> = {}) {
  const handlers = {
    onNewSession: vi.fn(),
    onProjectDelete: vi.fn(),
    onProjectWorkspacesToggle: vi.fn(),
    onWorkspaceSelect: vi.fn(),
  }
  render(
    <SidebarProvider><WorkspaceList
      activeProjectId="project-1"
      conversations={[]}
      projects={projects}
      projectStatuses={{}}
      t={t}
      {...handlers}
      {...overrides}
    /></SidebarProvider>,
  )
  return handlers
}

function openActions(name: string) {
  fireEvent.pointerDown(screen.getByRole('button', { name: `Actions for project ${name}` }), {
    button: 0,
    ctrlKey: false,
    pointerType: 'mouse',
  })
}

describe('WorkspaceList', () => {
  it('names each Workspace row exactly after its Project and marks the active one', () => {
    const handlers = list({ projectStatuses: { 'project-1': 'running', 'project-2': null } })
    const rows = screen.getByRole('list', { name: 'Workspaces' })
    const demo = within(rows).getByRole('button', { name: 'Demo' })
    expect(demo).toHaveAttribute('aria-current', 'true')
    expect(demo).toHaveAttribute('data-active', 'true')
    expect(demo).toHaveAttribute('data-session-status', 'running')
    expect(demo).toHaveAttribute('data-workspaces-enabled', 'false')
    expect(demo).toHaveAttribute('data-slot', 'sidebar-menu-button')
    expect(rows).toHaveAttribute('data-slot', 'sidebar-menu')
    expect(screen.getByRole('button', { name: 'Actions for project Demo' })).toHaveAttribute('data-sidebar', 'menu-action')
    const other = within(rows).getByRole('button', { name: 'Other' })
    expect(other).not.toHaveAttribute('aria-current')
    expect(other).not.toHaveAttribute('data-session-status')
    expect(other).toHaveAttribute('data-workspaces-enabled', 'true')
    // The run state is in words, not colour alone, and one live region says it for the list.
    expect(within(demo.closest('li') as HTMLElement).getByRole('img', { name: 'Running' })).toBeInTheDocument()
    expect(within(other.closest('li') as HTMLElement).queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent('Demo: Running')

    fireEvent.click(other)
    expect(handlers.onWorkspaceSelect).toHaveBeenCalledWith('project-2')
    // Expansion means nothing any more: there is no chevron.
    expect(screen.queryByRole('button', { name: /^(Expand|Collapse) project$/ })).not.toBeInTheDocument()
  })

  it('falls back to the Sessions’ own run state when the runs are not known yet', () => {
    const waiting = { id: 's1', project_id: 'project-2', latest_run_status: 'waiting_permission' } as Conversation
    list({ conversations: [waiting] })
    expect(screen.getByRole('button', { name: 'Other' }))
      .toHaveAttribute('data-session-status', 'waiting_permission')
    expect(screen.getByRole('img', { name: 'Permission required' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Other: Permission required')
  })

  it('offers New session, Enable workspaces, and Delete for a Project', async () => {
    const handlers = list()
    openActions('Other')
    expect(await screen.findByRole('menuitem', { name: 'Disable Workspaces' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'New session' }))
    expect(handlers.onNewSession).toHaveBeenCalledWith('project-2')

    openActions('Demo')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Enable Workspaces' }))
    expect(handlers.onProjectWorkspacesToggle).toHaveBeenCalledWith('project-1')

    openActions('Demo')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))
    expect(handlers.onProjectDelete).toHaveBeenCalledWith('project-1')
  })

  it('says how to start when there is no Project', () => {
    list({ projects: [], activeProjectId: null })
    expect(screen.getByText('Select or create a project').closest('[data-slot="empty"]')).not.toBeNull()
  })
})
