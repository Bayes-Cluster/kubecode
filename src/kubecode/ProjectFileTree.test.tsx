import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { KubecodeApi } from './api'
import { ProjectFileTree } from './ProjectFileTree'

describe('ProjectFileTree', () => {
  it('renders the Project as a root and lazily expands nested directories', async () => {
    const onOpenFile = vi.fn()
    const api = {
      listEntries: vi.fn().mockImplementation((_projectId: string, path: string) => Promise.resolve(
        path === 'docs'
          ? [{ name: 'guide.md', path: 'docs/guide.md', kind: 'file' }]
          : [{ name: 'docs', path: 'docs', kind: 'directory' }],
      )),
    } as unknown as KubecodeApi

    render(
      <ProjectFileTree
        api={api}
        onDirectoryChange={() => undefined}
        onOpenFile={onOpenFile}
        projectId="project-1"
        projectName="Demo"
        refreshVersion={0}
      />,
    )

    expect(screen.getByRole('tree')).toBeInTheDocument()
    expect(await screen.findByRole('treeitem', { name: /docs/ })).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByRole('treeitem', { name: /docs/ }))
    await waitFor(() => expect(api.listEntries).toHaveBeenCalledWith('project-1', 'docs'))
    fireEvent.click(await screen.findByRole('treeitem', { name: /guide.md/ }))

    expect(onOpenFile).toHaveBeenCalledWith({ name: 'guide.md', path: 'docs/guide.md', kind: 'file' })
  })
})
