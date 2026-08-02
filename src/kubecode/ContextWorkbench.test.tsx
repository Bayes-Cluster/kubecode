import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import { ContextWorkbench } from './ContextWorkbench'
import type { GitDiffResult, KubecodeApi } from './api'

vi.mock('./CodeEditor', () => ({
  CodeEditor: ({ content, onChange }: { content: string; onChange: (value: string) => void }) => (
    <div data-testid="code-editor">
      <span>{content}</span>
      <button onClick={() => onChange(`${content} edited`)}>Edit document</button>
    </div>
  ),
}))

afterEach(() => vi.useRealTimers())

describe('ContextWorkbench', () => {
  it('contains long Git errors in a dismissible alert', async () => {
    const message = "git command failed: error: pathspec 'a-very-long-file-name-that-does-not-exist.lock' did not match any files known to git"
    const api = {
      listEntries: vi.fn().mockResolvedValue([]),
      gitStatus: vi.fn().mockRejectedValue(new Error(message)),
    } as unknown as KubecodeApi

    render(
      <ContextWorkbench
        api={api}
        projectId="project-1"
        t={createTranslator('en')}
        width={260}
        workspaceEvents={[]}
      />,
    )

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveAttribute('title', message)
    expect(alert).toHaveTextContent(message)
    expect(alert.closest('[data-testid="context-workbench"]')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows Git changes in Explorer and stages a file', async () => {
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

    expect(screen.getByRole('tab', { name: 'Explorer' })).toHaveAttribute('data-state', 'active')
    expect(await screen.findByText('README.md')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Stage: README.md' }))
    await waitFor(() => {
      expect(api.mutateGit).toHaveBeenCalledWith('project-1', 'stage', ['README.md'])
    })
    expect(screen.getByText('Staged changes')).toBeInTheDocument()
  })

  it('loads untracked diffs from GitService and renders explicit unavailable reasons', async () => {
    const gitDiff = vi.fn()
      .mockResolvedValueOnce({ diff: '+server patch', unavailable_reason: null })
      .mockResolvedValueOnce({ diff: null, unavailable_reason: 'binary' })
    const api = {
      listEntries: vi.fn().mockResolvedValue([]),
      readFile: vi.fn(),
      gitStatus: vi.fn().mockResolvedValue({
        is_repository: true,
        branch: 'main',
        files: [
          {
            path: 'new file.txt', original_path: null, index_status: '?',
            worktree_status: '?', conflict: false,
          },
          {
            path: 'binary.dat', original_path: null, index_status: null,
            worktree_status: 'M', conflict: false,
          },
        ],
        truncated: false,
      }),
      gitDiff,
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

    fireEvent.click((await screen.findByText('new file.txt')).closest('button') as HTMLButtonElement)
    expect(await screen.findByText('+server patch')).toBeInTheDocument()
    expect(api.readFile).not.toHaveBeenCalled()
    expect(gitDiff).toHaveBeenCalledWith(
      'project-1',
      'new file.txt',
      false,
      expect.any(AbortSignal),
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Explorer' }))
    fireEvent.click(screen.getByText('binary.dat').closest('button') as HTMLButtonElement)
    expect(await screen.findByText('Binary diffs cannot be attached.')).toBeInTheDocument()
  })

  it('does not display a stale diff when the selection changes quickly', async () => {
    let resolveFirst!: (value: GitDiffResult) => void
    let resolveSecond!: (value: GitDiffResult) => void
    const gitDiff = vi.fn()
      .mockImplementationOnce(() => (
        new Promise<GitDiffResult>((resolve) => { resolveFirst = resolve })
      ))
      .mockImplementationOnce(() => (
        new Promise<GitDiffResult>((resolve) => { resolveSecond = resolve })
      ))
    const api = {
      listEntries: vi.fn().mockResolvedValue([]),
      gitStatus: vi.fn().mockResolvedValue({
        is_repository: true,
        branch: 'main',
        files: [
          { path: 'a.txt', original_path: null, index_status: null, worktree_status: 'M', conflict: false },
          { path: 'b.txt', original_path: null, index_status: null, worktree_status: 'M', conflict: false },
        ],
        truncated: false,
      }),
      gitDiff,
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

    fireEvent.click((await screen.findByText('a.txt')).closest('button') as HTMLButtonElement)
    expect(await screen.findByText('Loading diff…')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Explorer' }))
    fireEvent.click(screen.getByText('b.txt').closest('button') as HTMLButtonElement)
    expect(await screen.findByText('Loading diff…')).toBeInTheDocument()

    await act(async () => { resolveSecond({ diff: 'b diff', unavailable_reason: null }) })
    expect(await screen.findByText('b diff')).toBeInTheDocument()

    await act(async () => { resolveFirst({ diff: 'a diff', unavailable_reason: null }) })
    expect(screen.queryByText('a diff')).not.toBeInTheDocument()
    expect(screen.getByText('b diff')).toBeInTheDocument()
  })

  it('switches between staged and worktree diffs for a partially staged path', async () => {
    const gitDiff = vi.fn().mockImplementation(
      async (_projectId: string, _path: string, staged: boolean) => ({
        diff: `staged=${String(staged)} diff`,
        unavailable_reason: null,
      }),
    )
    const api = {
      listEntries: vi.fn().mockResolvedValue([]),
      gitStatus: vi.fn().mockResolvedValue({
        is_repository: true,
        branch: 'main',
        files: [{
          path: 'partial.txt',
          original_path: null,
          index_status: 'M',
          worktree_status: 'M',
          conflict: false,
        }],
        truncated: false,
      }),
      gitDiff,
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

    const rows = (await screen.findAllByText('partial.txt'))
      .filter((element) => element.closest('.kubecode-git-path'))
    expect(rows).toHaveLength(2)
    fireEvent.click(rows[0].closest('button') as HTMLButtonElement)
    expect(await screen.findByText('staged=true diff')).toBeInTheDocument()
    expect(gitDiff).toHaveBeenLastCalledWith(
      'project-1',
      'partial.txt',
      true,
      expect.any(AbortSignal),
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Explorer' }))
    const worktreeRows = screen.getAllByText('partial.txt')
      .filter((element) => element.closest('.kubecode-git-path'))
    fireEvent.click(worktreeRows[1].closest('button') as HTMLButtonElement)
    expect(await screen.findByText('staged=false diff')).toBeInTheDocument()
    expect(gitDiff).toHaveBeenLastCalledWith(
      'project-1',
      'partial.txt',
      false,
      expect.any(AbortSignal),
    )
  })

  it('aborts an in-flight diff and resets the view when the Project changes', async () => {
    const signals: AbortSignal[] = []
    let resolveDiff!: (value: GitDiffResult) => void
    const gitDiff = vi.fn().mockImplementation(
      (_projectId: string, _path: string, _staged: boolean, signal?: AbortSignal) => {
        signals.push(signal as AbortSignal)
        return new Promise<GitDiffResult>((resolve) => { resolveDiff = resolve })
      },
    )
    const api = {
      listEntries: vi.fn().mockResolvedValue([]),
      gitStatus: vi.fn().mockResolvedValue({
        is_repository: true,
        branch: 'main',
        files: [{ path: 'a.txt', original_path: null, index_status: null, worktree_status: 'M', conflict: false }],
        truncated: false,
      }),
      gitDiff,
    } as unknown as KubecodeApi
    const props = {
      api,
      t: createTranslator('en'),
      width: 440,
      workspaceEvents: [],
    }
    const { rerender } = render(<ContextWorkbench {...props} projectId="project-a" />)

    fireEvent.click((await screen.findByText('a.txt')).closest('button') as HTMLButtonElement)
    expect(await screen.findByText('Loading diff…')).toBeInTheDocument()
    expect(signals[0].aborted).toBe(false)

    rerender(<ContextWorkbench {...props} projectId="project-b" />)
    await waitFor(() => expect(signals[0].aborted).toBe(true))
    await act(async () => { resolveDiff({ diff: 'stale diff', unavailable_reason: null }) })
    expect(screen.queryByText('stale diff')).not.toBeInTheDocument()
  })

  it('renders a localized recoverable state for every bounded diff reason', async () => {
    const gitDiff = vi.fn().mockImplementation(async (_projectId: string, path: string) => {
      if (path === 'binary.dat') return { diff: null, unavailable_reason: 'binary' }
      if (path === 'large.txt') return { diff: null, unavailable_reason: 'oversized' }
      if (path === 'unsupported.txt') return { diff: null, unavailable_reason: 'unsupported' }
      return { diff: null, unavailable_reason: null }
    })
    const api = {
      listEntries: vi.fn().mockResolvedValue([]),
      gitStatus: vi.fn().mockResolvedValue({
        is_repository: true,
        branch: 'main',
        files: [
          { path: 'binary.dat', original_path: null, index_status: null, worktree_status: 'M', conflict: false },
          { path: 'large.txt', original_path: null, index_status: null, worktree_status: 'M', conflict: false },
          { path: 'unsupported.txt', original_path: null, index_status: null, worktree_status: 'M', conflict: false },
          { path: 'empty.txt', original_path: null, index_status: null, worktree_status: 'M', conflict: false },
        ],
        truncated: false,
      }),
      gitDiff,
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

    const clickRow = async (path: string) => {
      fireEvent.click((await screen.findByText(path)).closest('button') as HTMLButtonElement)
    }

    await clickRow('binary.dat')
    expect(await screen.findByText('Binary diffs cannot be attached.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Explorer' }))
    await clickRow('large.txt')
    expect(await screen.findByText('This diff exceeds the context byte limit. Select a smaller changed file instead.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Explorer' }))
    await clickRow('unsupported.txt')
    expect(await screen.findByText('This Git diff is unavailable.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Explorer' }))
    await clickRow('empty.txt')
    expect(await screen.findByText('No textual diff is available for this file.')).toBeInTheDocument()
  })

  it('shows a localized recoverable failed state and retries', async () => {
    const gitDiff = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ diff: 'recovered diff', unavailable_reason: null })
    const api = {
      listEntries: vi.fn().mockResolvedValue([]),
      gitStatus: vi.fn().mockResolvedValue({
        is_repository: true,
        branch: 'main',
        files: [{ path: 'a.txt', original_path: null, index_status: null, worktree_status: 'M', conflict: false }],
        truncated: false,
      }),
      gitDiff,
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

    fireEvent.click((await screen.findByText('a.txt')).closest('button') as HTMLButtonElement)
    expect(await screen.findByRole('alert')).toHaveTextContent('This diff could not be loaded.')
    expect(screen.getByText('boom')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('recovered diff')).toBeInTheDocument()
  })

  it('closes the diff view back to the Explorer surface', async () => {
    const api = {
      listEntries: vi.fn().mockResolvedValue([]),
      gitStatus: vi.fn().mockResolvedValue({
        is_repository: true,
        branch: 'main',
        files: [{ path: 'a.txt', original_path: null, index_status: null, worktree_status: 'M', conflict: false }],
        truncated: false,
      }),
      gitDiff: vi.fn().mockResolvedValue({ diff: 'a diff', unavailable_reason: null }),
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

    fireEvent.click((await screen.findByText('a.txt')).closest('button') as HTMLButtonElement)
    expect(await screen.findByText('a diff')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'a.txt' })).toHaveAttribute('data-state', 'active')

    fireEvent.click(screen.getByRole('button', { name: 'Close diff' }))
    expect(screen.getByRole('tab', { name: 'Explorer' })).toHaveAttribute('data-state', 'active')
    expect(screen.queryByText('a diff')).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'a.txt' })).not.toBeInTheDocument()
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
    expect(screen.getByRole('tab', { name: 'Explorer' })).toHaveAttribute('data-state', 'active')
    expect(screen.getByRole('button', { name: 'Changes' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Files' })).toHaveAttribute('aria-expanded', 'true')
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

  it('collapses Explorer sections without changing the active surface', async () => {
    const api = {
      listEntries: vi.fn().mockResolvedValue([]),
      gitStatus: vi.fn().mockResolvedValue({ is_repository: true, branch: 'main', files: [] }),
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

    await waitFor(() => expect(api.gitStatus).toHaveBeenCalled())
    const files = screen.getByRole('button', { name: 'Files' })
    fireEvent.click(files)
    expect(files).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('tab', { name: 'Explorer' })).toHaveAttribute('data-state', 'active')
  })

  it('shows the active Agent plan in its own Explorer section', async () => {
    const api = {
      listEntries: vi.fn().mockResolvedValue([]),
      gitStatus: vi.fn().mockResolvedValue({ is_repository: true, branch: 'main', files: [] }),
    } as unknown as KubecodeApi

    render(
      <ContextWorkbench
        api={api}
        planEntries={[
          { content: 'Inspect the project', priority: 'medium', status: 'completed' },
          { content: 'Implement the change', priority: 'high', status: 'in_progress' },
        ]}
        projectId="project-1"
        t={createTranslator('en')}
        width={440}
        workspaceEvents={[]}
      />,
    )

    expect(await screen.findByRole('button', { name: /Agent plan/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getByText('Inspect the project')).toBeInTheDocument()
    expect(screen.getByText('Implement the change')).toBeInTheDocument()
  })

  it('keeps multiple file drafts isolated and confirms before discarding one', async () => {
    const api = {
      listEntries: vi.fn().mockResolvedValue([
        { name: 'one.ts', path: 'src/one.ts', kind: 'file' },
        { name: 'two.ts', path: 'src/two.ts', kind: 'file' },
      ]),
      readFile: vi.fn().mockImplementation((_projectId: string, path: string) => Promise.resolve({
        path,
        content: path.includes('one') ? 'first' : 'second',
        revision: `revision:${path}`,
      })),
      gitStatus: vi.fn().mockResolvedValue({ is_repository: true, branch: 'main', files: [] }),
    } as unknown as KubecodeApi
    render(
      <ContextWorkbench
        api={api}
        projectId="project-1"
        projectName="Demo"
        t={createTranslator('en')}
        width={440}
        workspaceEvents={[]}
      />,
    )

    fireEvent.click(await screen.findByRole('treeitem', { name: /one.ts/ }))
    expect(await screen.findByText('first')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit document' }))
    expect(screen.getByText('first edited')).toBeInTheDocument()

    const explorer = screen.getByRole('tab', { name: 'Explorer' })
    fireEvent.pointerDown(explorer, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    fireEvent.click(explorer)
    fireEvent.click(await screen.findByRole('treeitem', { name: /two.ts/ }))
    expect(await screen.findByText('second')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /one.ts/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /two.ts/ })).toBeInTheDocument()

    const firstTab = screen.getByRole('tab', { name: /one.ts/ })
    fireEvent.pointerDown(firstTab, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    fireEvent.click(firstTab)
    expect(screen.getByText('first edited')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close editor' }))
    expect(screen.getByText(/Your edits to this file have not been saved/)).toBeInTheDocument()
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }))
    expect(screen.queryByRole('tab', { name: /one.ts/ })).not.toBeInTheDocument()
    expect(screen.getByText('second')).toBeInTheDocument()
  })

  it('keeps manual save as default and optionally saves after one second', async () => {
    const writeFile = vi.fn().mockResolvedValue({
      path: 'notes.md',
      content: 'draft edited',
      revision: 'revision-2',
    })
    const api = {
      listEntries: vi.fn().mockResolvedValue([
        { name: 'notes.md', path: 'notes.md', kind: 'file' },
      ]),
      readFile: vi.fn().mockResolvedValue({
        path: 'notes.md',
        content: 'draft',
        revision: 'revision-1',
      }),
      writeFile,
      gitStatus: vi.fn().mockResolvedValue({ is_repository: true, branch: 'main', files: [] }),
    } as unknown as KubecodeApi
    render(
      <ContextWorkbench
        api={api}
        autoSave
        projectId="project-1"
        projectName="Demo"
        t={createTranslator('en')}
        width={440}
        workspaceEvents={[]}
      />,
    )
    fireEvent.click(await screen.findByRole('treeitem', { name: /notes.md/ }))
    await screen.findByText('draft')
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Edit document' }))
    await act(() => vi.advanceTimersByTimeAsync(999))
    expect(writeFile).not.toHaveBeenCalled()
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(writeFile).toHaveBeenCalledWith(
      'project-1',
      'notes.md',
      'draft edited',
      'revision-1',
    )
  })

  it('opens the current Project quick file picker with Command-P', async () => {
    const api = {
      listEntries: vi.fn().mockResolvedValue([
        { name: 'README.md', path: 'README.md', kind: 'file' },
      ]),
      readFile: vi.fn().mockResolvedValue({
        path: 'README.md',
        content: '# Demo',
        revision: 'revision-1',
      }),
      gitStatus: vi.fn().mockResolvedValue({ is_repository: true, branch: 'main', files: [] }),
    } as unknown as KubecodeApi
    render(
      <ContextWorkbench
        api={api}
        projectId="project-1"
        projectName="Demo"
        t={createTranslator('en')}
        width={440}
        workspaceEvents={[]}
      />,
    )

    fireEvent.keyDown(document, { key: 'p', metaKey: true })
    const picker = await screen.findByRole('dialog', { name: 'Search files' })
    fireEvent.click(await within(picker).findByRole('option', { name: /README\.md/ }))

    expect(await screen.findByText('# Demo')).toBeInTheDocument()
    expect(api.readFile).toHaveBeenCalledWith('project-1', 'README.md')
  })

  it('creates a file from a relative path and opens it in the editor', async () => {
    const api = {
      createEntry: vi.fn().mockResolvedValue(undefined),
      listEntries: vi.fn().mockImplementation((_projectId: string, path: string) => Promise.resolve(
        path ? [] : [{ name: 'notes', path: 'notes', kind: 'directory' }],
      )),
      readFile: vi.fn().mockResolvedValue({
        path: 'notes/idea.md',
        content: '',
        revision: 'revision-1',
      }),
      gitStatus: vi.fn().mockResolvedValue({ is_repository: true, branch: 'main', files: [] }),
    } as unknown as KubecodeApi
    render(
      <ContextWorkbench
        api={api}
        projectId="project-1"
        projectName="Demo"
        t={createTranslator('en')}
        width={440}
        workspaceEvents={[]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'New file' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Relative path' }), {
      target: { value: 'notes/idea.md' },
    })
    expect(await screen.findByRole('option', { name: /^notes/ })).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('option', { name: /Create notes\/idea\.md/ }))

    await waitFor(() => {
      expect(api.createEntry).toHaveBeenCalledWith('project-1', 'notes/idea.md', 'file')
    })
    expect(api.readFile).toHaveBeenCalledWith('project-1', 'notes/idea.md')
  })
})
