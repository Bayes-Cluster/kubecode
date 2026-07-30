import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import { ComposerAddMenu } from './ComposerAddMenu'
import type { ComposerCatalogSnapshot, KubecodeApi } from './api'

const capabilityLabels = {
  disabledReason: (reason: string | null) => reason === 'ambiguous_source_identity'
    ? 'Same-name capabilities are ambiguous'
    : 'Unavailable',
  empty: 'No capabilities',
  error: 'Capabilities failed',
  kind: { skill: 'Skill', plugin_action: 'Plugin action', provider_app: 'Provider app' },
  loading: 'Loading capabilities',
  picker: 'Capabilities',
  scope: {
    session: 'Session', project: 'Project', user: 'User', bundled: 'Bundled', plugin: 'Plugin',
  },
} as const

const capabilityCatalog: ComposerCatalogSnapshot = {
  conversation_id: 'session-1', revision: 5, contexts: [],
  items: [
    {
      id: 'cap:project:review', kind: 'skill', name: 'review', description: 'Review changes',
      source_label: 'Project skill', scope: 'project', input_hint: null,
      enabled: true, disabled_reason: null,
    },
    {
      id: 'cap:user:review', kind: 'skill', name: 'review', description: 'Personal review',
      source_label: 'User skill', scope: 'user', input_hint: null,
      enabled: false, disabled_reason: 'ambiguous_source_identity',
    },
  ],
}

const commands = [
  { name: 'review', description: 'Review the current changes' },
  { name: 'skill-writer', description: 'Use the writing skill' },
]

describe('ComposerAddMenu', () => {
  it('discovers bounded Git diff contexts from the add menu without enabling rejected rows', async () => {
    const onGitDiff = vi.fn()
    const candidate = {
      path: 'src/main.ts', source_revision: 'a'.repeat(64), file_count: 1,
      hunk_count: 2, byte_count: 512, enabled: true, disabled_reason: null,
    }
    const rejected = {
      path: null, source_revision: 'b'.repeat(64), file_count: 0,
      hunk_count: 0, byte_count: 0, enabled: false,
      disabled_reason: 'git_diff_contains_unsupported',
    }
    render(
      <ComposerAddMenu
        api={{
          listComposerGitDiffs: vi.fn().mockResolvedValue({
            is_repository: true, candidates: [rejected, candidate],
          }),
        } as unknown as KubecodeApi}
        commands={[]}
        conversationId="session-1"
        gitDiffLabels={{
          all: 'Current Git changes',
          disabled: () => 'Select an eligible file',
          summary: (item) => `${item.file_count} files · ${item.hunk_count} hunks`,
        }}
        onGitDiff={onGitDiff}
        onInsert={vi.fn()}
        onReference={vi.fn()}
        projectId="project-1"
        t={createTranslator('en')}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    fireEvent.click(screen.getByRole('button', { name: /Reference Git changes/i }))

    expect(await screen.findByRole('button', { name: /Current Git changes/i })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /main\.ts/i }))
    expect(onGitDiff).toHaveBeenCalledWith(candidate)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('aligns the add palette to the full Composer surface', () => {
    render(
      <div data-testid="agent-composer-surface">
        <ComposerAddMenu
          api={{} as KubecodeApi}
          commands={[]}
          conversationId="session-1"
          onInsert={vi.fn()}
          onReference={vi.fn()}
          projectId="project-1"
          t={createTranslator('en')}
        />
      </div>,
    )

    const surface = screen.getByTestId('agent-composer-surface')
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({
      bottom: 60, height: 50, left: 10, right: 510, top: 10, width: 500, x: 10, y: 10,
      toJSON: () => ({}),
    })

    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))

    expect(screen.getByRole('dialog', { name: 'Add context' })).toHaveStyle({
      bottom: `${window.innerHeight - 10 + 12}px`,
      left: '10px',
      width: '500px',
    })
  })

  it('inserts a native Agent skill or command from the add menu', async () => {
    const onInsert = vi.fn()

    render(
      <ComposerAddMenu
        api={{} as KubecodeApi}
        commands={commands}
        conversationId="session-1"
        onInsert={onInsert}
        onReference={vi.fn()}
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

  it('uses the same ranked collision-safe capability selection from the add menu', () => {
    const onCapability = vi.fn()
    render(
      <ComposerAddMenu
        api={{} as KubecodeApi}
        capabilityCatalog={capabilityCatalog}
        capabilityLabels={capabilityLabels}
        capabilityStatus="ready"
        commands={[]}
        conversationId="session-1"
        onCapability={onCapability}
        onInsert={vi.fn()}
        onReference={vi.fn()}
        projectId="project-1"
        t={createTranslator('en')}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    const input = screen.getByRole('combobox', { name: 'Search skills, commands, and files' })
    fireEvent.change(input, { target: { value: 'review' } })
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(2)
    expect(options[0]).toHaveTextContent('Project skill')
    expect(options[1]).toBeDisabled()
    expect(input).toHaveAttribute('aria-controls', screen.getByRole('listbox').id)
    expect(input).toHaveAttribute('aria-activedescendant', options[0].id)
    expect(screen.queryByText('This Agent has not exposed any skills or commands yet.')).not.toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onCapability).toHaveBeenCalledWith(expect.objectContaining({
      catalogRevision: 5,
      id: 'cap:project:review',
      kind: 'skill',
    }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows a graceful capability absence without hiding native commands', () => {
    render(
      <ComposerAddMenu
        api={{} as KubecodeApi}
        capabilityEmptyLabel="No separately invocable OpenCode capabilities are available for this Session."
        commands={commands}
        conversationId="session-1"
        onInsert={vi.fn()}
        onReference={vi.fn()}
        projectId="project-1"
        t={createTranslator('en')}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))

    expect(screen.getByRole('status')).toHaveTextContent(
      'No separately invocable OpenCode capabilities are available for this Session.',
    )
    expect(screen.getByRole('button', { name: /review/i })).toBeInTheDocument()
  })

  it('inserts a typed Session file reference selected from the flat picker', async () => {
    const onReference = vi.fn()
    const api = {
      listSessionEntries: vi.fn().mockResolvedValue([
        { kind: 'file', name: 'README.md', path: 'README.md' },
        { kind: 'directory', name: 'src', path: 'src' },
      ]),
    } as unknown as KubecodeApi

    render(
      <ComposerAddMenu
        api={api}
        commands={[]}
        conversationId="session-1"
        onInsert={vi.fn()}
        onReference={onReference}
        projectId="project-1"
        t={createTranslator('en')}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    fireEvent.click(screen.getByRole('button', { name: /Reference file/i }))
    fireEvent.click(await screen.findByRole('option', { name: /README\.md/i }))

    await waitFor(() => expect(onReference).toHaveBeenCalledWith({
      kind: 'file', name: 'README.md', path: 'README.md',
    }))
    expect(api.listSessionEntries).toHaveBeenCalledWith('session-1', '')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
