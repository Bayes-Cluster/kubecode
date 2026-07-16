import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import { ComposerAddMenu } from './ComposerAddMenu'
import type { KubecodeApi } from './api'

const commands = [
  { name: 'review', description: 'Review the current changes' },
  { name: 'skill-writer', description: 'Use the writing skill' },
]

describe('ComposerAddMenu', () => {
  it('aligns the add palette to the full Composer surface', () => {
    render(
      <div data-testid="agent-composer-surface">
        <ComposerAddMenu
          api={{} as KubecodeApi}
          commands={[]}
          onInsert={vi.fn()}
          projectId="project-1"
          t={createTranslator('en')}
        />
      </div>,
    )

    const surface = screen.getByTestId('agent-composer-surface')
    const root = screen.getByRole('button', { name: 'Add context' }).parentElement
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({
      bottom: 60, height: 50, left: 10, right: 510, top: 10, width: 500, x: 10, y: 10,
      toJSON: () => ({}),
    })
    vi.spyOn(root as HTMLElement, 'getBoundingClientRect').mockReturnValue({
      bottom: 55, height: 32, left: 30, right: 62, top: 23, width: 32, x: 30, y: 23,
      toJSON: () => ({}),
    })

    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))

    expect(screen.getByRole('dialog', { name: 'Add context' })).toHaveStyle({
      left: '-20px',
      width: '500px',
    })
  })

  it('inserts a native Agent skill or command from the add menu', async () => {
    const onInsert = vi.fn()

    render(
      <ComposerAddMenu
        api={{} as KubecodeApi}
        commands={commands}
        onInsert={onInsert}
        projectId="project-1"
        t={createTranslator('en')}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    expect(screen.getByRole('dialog', { name: 'Add context' })).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search skills, commands, and files' }), {
      target: { value: 'review' },
    })
    fireEvent.click(screen.getByRole('button', { name: /review/i }))

    expect(onInsert).toHaveBeenCalledWith('/review ', 'command')
  })

  it('inserts a project file reference selected from the file tree', async () => {
    const onInsert = vi.fn()
    const api = {
      listEntries: vi.fn().mockResolvedValue([
        { kind: 'file', name: 'README.md', path: 'README.md' },
      ]),
    } as unknown as KubecodeApi

    render(
      <ComposerAddMenu
        api={api}
        commands={[]}
        onInsert={onInsert}
        projectId="project-1"
        t={createTranslator('en')}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    fireEvent.click(screen.getByRole('button', { name: /Reference file/i }))
    fireEvent.click(await screen.findByRole('treeitem', { name: /README\.md/i }))

    await waitFor(() => expect(onInsert).toHaveBeenCalledWith('@README.md ', 'file'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
