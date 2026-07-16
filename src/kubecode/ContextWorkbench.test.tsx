import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import { ContextWorkbench } from './ContextWorkbench'
import type { KubecodeApi } from './api'

vi.mock('./CodeEditor', () => ({
  CodeEditor: () => <div data-testid="code-editor" />,
}))

describe('ContextWorkbench', () => {
  it('shows Git changes in Review and stages a file', async () => {
    const cleanAfterStage = {
      is_repository: true,
      branch: 'main',
      files: [{ path: 'README.md', index_status: 'M', worktree_status: null }],
    }
    const api = {
      listEntries: vi.fn().mockResolvedValue([]),
      gitStatus: vi.fn().mockResolvedValue({
        is_repository: true,
        branch: 'main',
        files: [{ path: 'README.md', index_status: null, worktree_status: 'M' }],
      }),
      mutateGit: vi.fn().mockResolvedValue(cleanAfterStage),
    } as unknown as KubecodeApi

    render(
      <ContextWorkbench
        api={api}
        projectId="project-1"
        t={createTranslator('en')}
        width={440}
        workspaceEvents={[]}
      />,
    )

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Changes' }), { button: 0 })
    expect(await screen.findByText('README.md')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Stage: README.md' }))
    await waitFor(() => {
      expect(api.mutateGit).toHaveBeenCalledWith('project-1', 'stage', ['README.md'])
    })
    expect(screen.getByText('Staged changes')).toBeInTheDocument()
  })

  it('initializes Git from an untracked project', async () => {
    const api = {
      listEntries: vi.fn().mockResolvedValue([]),
      gitStatus: vi.fn().mockResolvedValue({ is_repository: false, branch: null, files: [] }),
      initializeGit: vi.fn().mockResolvedValue({ is_repository: true, branch: 'main', files: [] }),
    } as unknown as KubecodeApi
    render(
      <ContextWorkbench
        api={api}
        projectId="project-1"
        t={createTranslator('en')}
        width={440}
        workspaceEvents={[]}
      />,
    )

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Changes' }), { button: 0 })
    fireEvent.click(await screen.findByRole('button', { name: 'Create a Git repository' }))
    await waitFor(() => expect(api.initializeGit).toHaveBeenCalledWith('project-1'))
    expect(screen.getByText('No changes to review')).toBeInTheDocument()
  })

  it('refreshes Files when a file event is followed by another workspace event', async () => {
    const api = {
      listEntries: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([
          { name: 'new-file.ts', path: 'new-file.ts', kind: 'file' },
          { name: 'new-folder', path: 'new-folder', kind: 'directory' },
        ]),
      gitStatus: vi.fn().mockResolvedValue({ is_repository: false, branch: null, files: [] }),
    } as unknown as KubecodeApi
    const props = {
      api,
      projectId: 'project-1',
      t: createTranslator('en'),
      width: 440,
    }
    const { rerender } = render(<ContextWorkbench {...props} workspaceEvents={[]} />)
    expect(screen.getByRole('tab', { name: 'Changes' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('data-state', 'active')
    await waitFor(() => expect(api.listEntries).toHaveBeenCalledTimes(1))

    rerender(<ContextWorkbench {...props} workspaceEvents={[
      {
        id: 10,
        kind: 'file_changed',
        project_id: 'project-1',
        conversation_id: null,
        run_id: null,
        payload: { path: 'new-file.ts' },
        created_at: 'now',
      },
      {
        id: 11,
        kind: 'git_changed',
        project_id: 'project-1',
        conversation_id: null,
        run_id: null,
        payload: {},
        created_at: 'now',
      },
    ]} />)

    await waitFor(() => expect(api.listEntries).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('new-file.ts')).toBeInTheDocument()
    expect(screen.getByText('new-folder')).toBeInTheDocument()
  })
})
