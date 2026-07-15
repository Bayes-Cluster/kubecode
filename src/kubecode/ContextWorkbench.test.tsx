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
        workspaceEvent={null}
      />,
    )

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
        workspaceEvent={null}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Create a Git repository' }))
    await waitFor(() => expect(api.initializeGit).toHaveBeenCalledWith('project-1'))
    expect(screen.getByText('No changes to review')).toBeInTheDocument()
  })
})
