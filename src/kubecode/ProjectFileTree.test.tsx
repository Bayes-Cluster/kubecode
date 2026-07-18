import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

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
        t={createTranslator('en')}
      />,
    )

    expect(screen.getByRole('tree')).toBeInTheDocument()
    expect(await screen.findByRole('treeitem', { name: /docs/ })).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByRole('treeitem', { name: /docs/ }))
    await waitFor(() => expect(api.listEntries).toHaveBeenCalledWith('project-1', 'docs'))
    fireEvent.click(await screen.findByRole('treeitem', { name: /guide.md/ }))

    expect(onOpenFile).toHaveBeenCalledWith({ name: 'guide.md', path: 'docs/guide.md', kind: 'file' })
  })

  it('keeps the tree compact and can reveal ignored or hidden root entries', async () => {
    const api = {
      listEntries: vi.fn().mockImplementation((_projectId: string, path: string) => {
        if (path === 'src') {
          return Promise.resolve([
            { name: 'main.ts', path: 'src/main.ts', kind: 'file' },
          ])
        }
        if (path !== '') return Promise.resolve([])
        return Promise.resolve([
          { name: 'src', path: 'src', kind: 'directory' },
          { name: 'node_modules', path: 'node_modules', kind: 'directory', ignored: true },
          { name: '.env', path: '.env', kind: 'file', hidden: true },
        ])
      }),
    } as unknown as KubecodeApi
    render(
      <ProjectFileTree
        api={api}
        onDirectoryChange={() => undefined}
        onOpenFile={vi.fn()}
        projectId="project-1"
        projectName="Demo"
        refreshVersion={0}
        t={createTranslator('en')}
      />,
    )

    expect(await screen.findByRole('treeitem', { name: /src/ })).toBeInTheDocument()
    expect(screen.queryByRole('treeitem', { name: /node_modules/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Search files' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show hidden and ignored files' }))
    expect(await screen.findByRole('treeitem', { name: /\.env/ })).toBeInTheDocument()
    expect(screen.getByRole('treeitem', { name: /node_modules/ })).toBeInTheDocument()
  })
})
