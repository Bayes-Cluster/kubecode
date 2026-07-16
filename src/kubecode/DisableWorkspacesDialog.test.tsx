import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import { DisableWorkspacesDialog } from './DisableWorkspacesDialog'
import type { KubecodeApi, Project } from './api'

const project: Project = {
  id: 'project-1',
  name: 'Demo',
  path: '/demo',
  workspaces_enabled: true,
}

describe('DisableWorkspacesDialog', () => {
  it('requires and submits an explicit strategy for every worktree', async () => {
    const migrateProjectWorkspaces = vi.fn().mockResolvedValue({
      project: { ...project, workspaces_enabled: false },
      exports: [],
    })
    const api = {
      getWorkspaceMigration: vi.fn().mockResolvedValue({
        active_conversation_ids: [],
        worktrees: [{
          conversation_id: 'session-1',
          title: 'Agent work',
          path: '/state/worktrees/session-1',
          dirty: true,
        }],
      }),
      migrateProjectWorkspaces,
    } as unknown as KubecodeApi
    const onMigrated = vi.fn()

    render(
      <DisableWorkspacesDialog
        api={api}
        onMigrated={onMigrated}
        onOpenChange={vi.fn()}
        open
        project={project}
        t={createTranslator('en')}
      />,
    )

    await screen.findByText('Agent work')
    expect(screen.getByRole('button', { name: 'Disable Workspaces' })).toBeDisabled()
    fireEvent.click(screen.getByRole('combobox', { name: 'Resolution for Agent work' }))
    fireEvent.click(await screen.findByText('Export patch'))
    fireEvent.click(screen.getByRole('button', { name: 'Disable Workspaces' }))

    await waitFor(() => expect(migrateProjectWorkspaces).toHaveBeenCalledWith('project-1', [{
      conversation_id: 'session-1',
      strategy: 'export_patch',
    }]))
    expect(onMigrated).toHaveBeenCalledWith(expect.objectContaining({ workspaces_enabled: false }))
  })
})
