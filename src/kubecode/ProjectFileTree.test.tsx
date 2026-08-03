import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { VirtuosoMockContext } from 'react-virtuoso'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import type { Entry, KubecodeApi } from './api'
import type { FileTreeInvalidation } from './fileTreeInvalidation'
import { ProjectFileTree } from './ProjectFileTree'

function renderTree(
  api: KubecodeApi,
  props: Partial<Parameters<typeof ProjectFileTree>[0]> = {},
) {
  return render(
    <ProjectFileTree
      api={api}
      invalidations={[]}
      onDirectoryChange={() => undefined}
      onOpenFile={vi.fn()}
      projectId="project-1"
      projectName="Demo"
      refreshVersion={0}
      t={createTranslator('en')}
      {...props}
    />,
  )
}

describe('ProjectFileTree', () => {
  beforeEach(() => {
    globalThis.sessionStorage?.clear()
  })

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

  it('keeps the tree compact and can reveal hidden, ignored, or generated root entries', async () => {
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
          { name: 'node_modules', path: 'node_modules', kind: 'directory', generated: true },
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

    fireEvent.click(screen.getByRole('button', { name: 'Show hidden, ignored, and generated files' }))
    expect(await screen.findByRole('treeitem', { name: /\.env/ })).toBeInTheDocument()
    expect(screen.getByRole('treeitem', { name: /node_modules/ })).toBeInTheDocument()
  })

  it('expanding a directory loads only that directory', async () => {
    const listEntries = vi.fn().mockImplementation((_projectId: string, path: string) => {
      if (path === 'src') {
        return Promise.resolve([{ name: 'a.ts', path: 'src/a.ts', kind: 'file' }])
      }
      if (path === 'docs') {
        return Promise.resolve([{ name: 'guide.md', path: 'docs/guide.md', kind: 'file' }])
      }
      return Promise.resolve([
        { name: 'src', path: 'src', kind: 'directory' },
        { name: 'docs', path: 'docs', kind: 'directory' },
      ])
    })
    renderTree({ listEntries } as unknown as KubecodeApi)

    expect(await screen.findByRole('treeitem', { name: /src/ })).toBeInTheDocument()
    expect(listEntries).toHaveBeenCalledWith('project-1', '')
    fireEvent.click(screen.getByRole('treeitem', { name: /src/ }))
    await waitFor(() => expect(listEntries).toHaveBeenCalledWith('project-1', 'src'))
    expect(listEntries).not.toHaveBeenCalledWith('project-1', 'docs')
    fireEvent.click(screen.getByRole('treeitem', { name: /docs/ }))
    await waitFor(() => expect(listEntries).toHaveBeenCalledWith('project-1', 'docs'))
  })

  it('a scoped invalidation reloads only the affected loaded parent', async () => {
    const listEntries = vi.fn().mockImplementation((_projectId: string, path: string) => {
      if (path === 'src') {
        return Promise.resolve([{ name: 'a.ts', path: 'src/a.ts', kind: 'file' }])
      }
      if (path === 'docs') {
        return Promise.resolve([{ name: 'guide.md', path: 'docs/guide.md', kind: 'file' }])
      }
      return Promise.resolve([
        { name: 'src', path: 'src', kind: 'directory' },
        { name: 'docs', path: 'docs', kind: 'directory' },
      ])
    })
    const { rerender } = renderTree({ listEntries } as unknown as KubecodeApi)
    fireEvent.click(await screen.findByRole('treeitem', { name: /src/ }))
    fireEvent.click(await screen.findByRole('treeitem', { name: /docs/ }))
    await waitFor(() => expect(listEntries).toHaveBeenCalledWith('project-1', 'src'))
    await waitFor(() => expect(listEntries).toHaveBeenCalledWith('project-1', 'docs'))
    const srcCalls = listEntries.mock.calls.filter(([, path]) => path === 'src').length
    const docsCalls = listEntries.mock.calls.filter(([, path]) => path === 'docs').length

    rerender(<ProjectFileTree
      api={{ listEntries } as unknown as KubecodeApi}
      invalidations={[{ id: 1, payload: { paths: ['src/a.ts'] } }]}
      onDirectoryChange={() => undefined}
      onOpenFile={vi.fn()}
      projectId="project-1"
      projectName="Demo"
      refreshVersion={0}
      t={createTranslator('en')}
    />)

    await waitFor(() => {
      expect(
        listEntries.mock.calls.filter(([, path]) => path === 'src').length,
      ).toBeGreaterThan(srcCalls)
    })
    expect(
      listEntries.mock.calls.filter(([, path]) => path === 'docs').length,
    ).toBe(docsCalls)
  })

  it('a cross-directory rename refreshes both parents and evicts stale descendant caches', async () => {
    const listEntries = vi.fn().mockImplementation((_projectId: string, path: string) => {
      if (path === 'old') {
        return Promise.resolve([{ name: 'sub', path: 'old/sub', kind: 'directory' }])
      }
      if (path === 'old/sub') {
        return Promise.resolve([{ name: 'deep.txt', path: 'old/sub/deep.txt', kind: 'file' }])
      }
      if (path === 'new' || path === 'docs') return Promise.resolve([])
      return Promise.resolve([
        { name: 'old', path: 'old', kind: 'directory' },
        { name: 'new', path: 'new', kind: 'directory' },
        { name: 'docs', path: 'docs', kind: 'directory' },
      ])
    })
    const { rerender } = renderTree({ listEntries } as unknown as KubecodeApi)
    fireEvent.click(await screen.findByRole('treeitem', { name: /old/ }))
    fireEvent.click(await screen.findByRole('treeitem', { name: /sub/ }))
    fireEvent.click(await screen.findByRole('treeitem', { name: /new/ }))
    await waitFor(() => expect(listEntries).toHaveBeenCalledWith('project-1', 'old'))
    await waitFor(() => expect(listEntries).toHaveBeenCalledWith('project-1', 'old/sub'))
    await waitFor(() => expect(listEntries).toHaveBeenCalledWith('project-1', 'new'))
    const countFor = (path: string) => (
      listEntries.mock.calls.filter(([, called]) => called === path).length
    )
    const oldBefore = countFor('old')
    const newBefore = countFor('new')
    const oldSubBefore = countFor('old/sub')
    const docsBefore = countFor('docs')

    rerender(<ProjectFileTree
      api={{ listEntries } as unknown as KubecodeApi}
      invalidations={[{ id: 1, payload: { paths: ['old/sub', 'new/sub'] } }]}
      onDirectoryChange={() => undefined}
      onOpenFile={vi.fn()}
      projectId="project-1"
      projectName="Demo"
      refreshVersion={0}
      t={createTranslator('en')}
    />)

    await waitFor(() => {
      expect(countFor('old')).toBeGreaterThan(oldBefore)
      expect(countFor('new')).toBeGreaterThan(newBefore)
      expect(countFor('old/sub')).toBeGreaterThan(oldSubBefore)
    })
    expect(countFor('docs')).toBe(docsBefore)
  })

  it('a late response from a stale request generation cannot overwrite current state', async () => {
    let srcCalls = 0
    let resolveFirst: (value: Entry[]) => void = () => undefined
    let resolveSecond: (value: Entry[]) => void = () => undefined
    const listEntries = vi.fn().mockImplementation((_projectId: string, path: string) => {
      if (path === 'src') {
        srcCalls += 1
        if (srcCalls === 1) {
          return new Promise<Entry[]>((resolve) => { resolveFirst = resolve })
        }
        return new Promise<Entry[]>((resolve) => { resolveSecond = resolve })
      }
      if (path !== '') return Promise.resolve([])
      return Promise.resolve([{ name: 'src', path: 'src', kind: 'directory' }])
    })
    const { rerender } = renderTree({ listEntries } as unknown as KubecodeApi)
    fireEvent.click(await screen.findByRole('treeitem', { name: /src/ }))
    await waitFor(() => expect(listEntries).toHaveBeenCalledWith('project-1', 'src'))

    rerender(<ProjectFileTree
      api={{ listEntries } as unknown as KubecodeApi}
      invalidations={[{ id: 1, payload: { paths: ['src/a.ts'] } }]}
      onDirectoryChange={() => undefined}
      onOpenFile={vi.fn()}
      projectId="project-1"
      projectName="Demo"
      refreshVersion={0}
      t={createTranslator('en')}
    />)

    await waitFor(() => expect(srcCalls).toBeGreaterThanOrEqual(2))
    await act(async () => { resolveSecond([{ name: 'b.ts', path: 'src/b.ts', kind: 'file' }]) })
    expect(await screen.findByRole('treeitem', { name: /b\.ts/ })).toBeInTheDocument()

    await act(async () => { resolveFirst([{ name: 'a.ts', path: 'src/a.ts', kind: 'file' }]) })
    expect(screen.queryByRole('treeitem', { name: /a\.ts/ })).not.toBeInTheDocument()
    expect(screen.getByRole('treeitem', { name: /b\.ts/ })).toBeInTheDocument()
  })

  it('a full reconciliation reloads every loaded directory', async () => {
    const listEntries = vi.fn().mockImplementation((_projectId: string, path: string) => {
      if (path === 'src') {
        return Promise.resolve([{ name: 'a.ts', path: 'src/a.ts', kind: 'file' }])
      }
      if (path === 'docs') {
        return Promise.resolve([{ name: 'guide.md', path: 'docs/guide.md', kind: 'file' }])
      }
      return Promise.resolve([
        { name: 'src', path: 'src', kind: 'directory' },
        { name: 'docs', path: 'docs', kind: 'directory' },
      ])
    })
    const { rerender } = renderTree({ listEntries } as unknown as KubecodeApi)
    fireEvent.click(await screen.findByRole('treeitem', { name: /src/ }))
    fireEvent.click(await screen.findByRole('treeitem', { name: /docs/ }))
    await waitFor(() => expect(listEntries).toHaveBeenCalledWith('project-1', 'src'))
    await waitFor(() => expect(listEntries).toHaveBeenCalledWith('project-1', 'docs'))
    const srcCalls = listEntries.mock.calls.filter(([, path]) => path === 'src').length
    const docsCalls = listEntries.mock.calls.filter(([, path]) => path === 'docs').length

    rerender(<ProjectFileTree
      api={{ listEntries } as unknown as KubecodeApi}
      invalidations={[]}
      onDirectoryChange={() => undefined}
      onOpenFile={vi.fn()}
      projectId="project-1"
      projectName="Demo"
      refreshVersion={1}
      t={createTranslator('en')}
    />)

    await waitFor(() => {
      expect(
        listEntries.mock.calls.filter(([, path]) => path === 'src').length,
      ).toBeGreaterThan(srcCalls)
    })
    await waitFor(() => {
      expect(
        listEntries.mock.calls.filter(([, path]) => path === 'docs').length,
      ).toBeGreaterThan(docsCalls)
    })
  })

  it('a full invalidation payload reloads every loaded directory without server paths', async () => {
    const listEntries = vi.fn().mockImplementation((_projectId: string, path: string) => {
      if (path === 'src') {
        return Promise.resolve([{ name: 'a.ts', path: 'src/a.ts', kind: 'file' }])
      }
      return Promise.resolve([{ name: 'src', path: 'src', kind: 'directory' }])
    })
    const { rerender } = renderTree({ listEntries } as unknown as KubecodeApi)
    fireEvent.click(await screen.findByRole('treeitem', { name: /src/ }))
    await waitFor(() => expect(listEntries).toHaveBeenCalledWith('project-1', 'src'))
    const srcCalls = listEntries.mock.calls.filter(([, path]) => path === 'src').length

    rerender(<ProjectFileTree
      api={{ listEntries } as unknown as KubecodeApi}
      invalidations={[{ id: 1, payload: { paths: [], full: true } } as FileTreeInvalidation]}
      onDirectoryChange={() => undefined}
      onOpenFile={vi.fn()}
      projectId="project-1"
      projectName="Demo"
      refreshVersion={0}
      t={createTranslator('en')}
    />)

    await waitFor(() => {
      expect(
        listEntries.mock.calls.filter(([, path]) => path === 'src').length,
      ).toBeGreaterThan(srcCalls)
    })
  })

  it('preserves expanded directories in sessionStorage across remounts', async () => {
    const listEntries = vi.fn().mockImplementation((_projectId: string, path: string) => {
      if (path === 'src') {
        return Promise.resolve([{ name: 'a.ts', path: 'src/a.ts', kind: 'file' }])
      }
      return Promise.resolve([{ name: 'src', path: 'src', kind: 'directory' }])
    })
    const props = {
      api: { listEntries } as unknown as KubecodeApi,
      onDirectoryChange: () => undefined,
      onOpenFile: vi.fn(),
      projectId: 'project-storage',
      projectName: 'Demo',
      refreshVersion: 0,
      t: createTranslator('en'),
    }
    const first = render(<ProjectFileTree invalidations={[]} {...props} />)
    fireEvent.click(await screen.findByRole('treeitem', { name: /src/ }))
    await waitFor(() => expect(screen.getByRole('treeitem', { name: /src/ })).toHaveAttribute('aria-expanded', 'true'))
    first.unmount()

    render(<ProjectFileTree invalidations={[]} {...props} />)
    expect(await screen.findByRole('treeitem', { name: /src/ })).toHaveAttribute('aria-expanded', 'true')
    await waitFor(() => expect(listEntries).toHaveBeenCalledWith('project-storage', 'src'))
  })

  it('exposes tree levels and keyboard navigation for the active row', async () => {
    const api = {
      listEntries: vi.fn().mockImplementation((_projectId: string, path: string) => Promise.resolve(
        path === 'src'
          ? [{ name: 'main.ts', path: 'src/main.ts', kind: 'file' }]
          : [{ name: 'src', path: 'src', kind: 'directory' }, { name: 'README.md', path: 'README.md', kind: 'file' }],
      )),
    } as unknown as KubecodeApi

    renderTree(api)
    const tree = await screen.findByRole('tree')
    const root = await screen.findByRole('treeitem', { name: /Demo/ })
    const src = screen.getByRole('treeitem', { name: /src/ })
    expect(root).toHaveAttribute('aria-level', '1')
    expect(src).toHaveAttribute('aria-level', '2')
    expect(root).toHaveAttribute('tabindex', '0')

    tree.focus()
    fireEvent.keyDown(tree, { key: 'ArrowDown' })
    expect(src).toHaveAttribute('aria-selected', 'true')
    expect(src).toHaveAttribute('tabindex', '0')
    expect(src).toHaveFocus()

    fireEvent.keyDown(src, { key: 'ArrowRight' })
    expect(src).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByRole('treeitem', { name: /main.ts/ })).toHaveAttribute('aria-level', '3')
  })

  it('bounds mounted rows for a large cached directory', async () => {
    const entries = Array.from({ length: 1_200 }, (_value, index) => ({
      kind: 'file' as const,
      name: `file-${index}.ts`,
      path: `file-${index}.ts`,
    }))
    const api = {
      listEntries: vi.fn().mockResolvedValue(entries),
    } as unknown as KubecodeApi

    render(
      <VirtuosoMockContext.Provider value={{ itemHeight: 26, viewportHeight: 260 }}>
        <ProjectFileTree
          api={api}
          onDirectoryChange={() => undefined}
          onOpenFile={vi.fn()}
          projectId="project-1"
          projectName="Demo"
          refreshVersion={0}
          t={createTranslator('en')}
        />
      </VirtuosoMockContext.Provider>,
    )
    const tree = await screen.findByRole('tree')
    await waitFor(() => expect(tree.querySelectorAll('[role="treeitem"]').length).toBeGreaterThan(0))
    expect(tree.querySelectorAll('[role="treeitem"]').length).toBeLessThan(entries.length)
    expect(tree).toHaveAttribute('data-virtualized', 'true')
  })

  it('moves keyboard focus through virtual windows without changing row identity', async () => {
    const entries = Array.from({ length: 1_200 }, (_value, index) => ({
      kind: 'file' as const,
      name: `file-${index}.ts`,
      path: `file-${index}.ts`,
    }))
    const api = {
      listEntries: vi.fn().mockResolvedValue(entries),
    } as unknown as KubecodeApi

    render(
      <VirtuosoMockContext.Provider value={{ itemHeight: 26, viewportHeight: 260 }}>
        <ProjectFileTree
          api={api}
          onDirectoryChange={() => undefined}
          onOpenFile={vi.fn()}
          projectId="project-1"
          projectName="Demo"
          refreshVersion={0}
          t={createTranslator('en')}
        />
      </VirtuosoMockContext.Provider>,
    )
    const tree = await screen.findByRole('tree')
    tree.focus()
    for (let index = 0; index < 260; index += 1) {
      fireEvent.keyDown(tree, { key: 'ArrowDown' })
    }

    await waitFor(() => expect(tree).toHaveAttribute('data-active-path', 'file-259.ts'))
    expect(tree).toHaveAttribute('data-selected-path', 'file-259.ts')
    expect(tree.querySelectorAll('[role="treeitem"]').length).toBeGreaterThan(0)
    expect(tree.querySelectorAll('[role="treeitem"]').length).toBeLessThan(entries.length + 1)
  })
})
