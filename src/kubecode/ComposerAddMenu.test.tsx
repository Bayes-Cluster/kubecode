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
  it('groups visible Session turns and submits only the stable turn selector and role', () => {
    const onSessionTurnContext = vi.fn()
    render(
      <ComposerAddMenu
        api={{} as KubecodeApi}
        commands={[]}
        conversationId="session-1"
        onInsert={vi.fn()}
        onReference={vi.fn()}
        onSessionTurnContext={onSessionTurnContext}
        projectId="project-1"
        sessionTurnSources={[{
          turnId: 'private-run-id',
          userPreview: 'Private user question',
          agentPreview: 'Private Agent response',
        }]}
        t={createTranslator('en')}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    expect(screen.getByRole('button', { name: /Diagnostics unavailable/i })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /Reference Session turns/i }))
    expect(screen.getByRole('group', { name: 'User turns' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Agent responses' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Attach prior Agent response/i }))

    expect(onSessionTurnContext).toHaveBeenCalledWith({
      role: 'agent',
      turnId: 'private-run-id',
    })
    expect(JSON.stringify(onSessionTurnContext.mock.calls)).not.toContain('Private Agent response')
  })

  it('attaches only an explicit terminal selection or explicit bounded recent output', () => {
    const onTerminalContext = vi.fn()
    render(
      <ComposerAddMenu
        api={{} as KubecodeApi}
        commands={[]}
        conversationId="session-1"
        onInsert={vi.fn()}
        onReference={vi.fn()}
        onTerminalContext={onTerminalContext}
        projectId="project-1"
        t={createTranslator('en')}
        terminalSources={[
          { terminalId: 'terminal-1', paneIndex: 1, selectedText: null },
          { terminalId: 'terminal-2', paneIndex: 2, selectedText: 'selected output' },
        ]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    fireEvent.click(screen.getByRole('button', { name: /Reference terminal output/i }))

    expect(screen.getByRole('button', {
      name: /Attach selected output from Terminal pane 1/i,
    })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', {
      name: /Attach selected output from Terminal pane 2/i,
    }))
    expect(onTerminalContext).toHaveBeenLastCalledWith({
      capture: 'selection',
      selectedText: 'selected output',
      terminalId: 'terminal-2',
    })

    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    fireEvent.click(screen.getByRole('button', { name: /Reference terminal output/i }))
    fireEvent.click(screen.getByRole('button', {
      name: /Attach recent output from Terminal pane 1/i,
    }))
    expect(onTerminalContext).toHaveBeenLastCalledWith({
      capture: 'recent',
      terminalId: 'terminal-1',
    })
  })

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

    // The official Popover places it above the composer; it is as wide as the composer.
    const palette = screen.getByRole('dialog', { name: 'Add context' })
    expect(palette).toHaveAttribute('data-slot', 'popover-content')
    expect(palette).toHaveStyle({ width: '500px' })
  })

  it('closes with Escape through the official Popover and returns focus to its button', async () => {
    render(
      <ComposerAddMenu
        api={{} as KubecodeApi}
        commands={commands}
        conversationId="session-1"
        onInsert={vi.fn()}
        onReference={vi.fn()}
        projectId="project-1"
        t={createTranslator('en')}
      />,
    )
    const trigger = screen.getByRole('button', { name: 'Add context' })
    fireEvent.click(trigger)
    const palette = screen.getByRole('dialog', { name: 'Add context' })
    fireEvent.keyDown(palette, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add context' })).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
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
    fireEvent.change(screen.getByRole('combobox', { name: 'Search skills, commands, and files' }), {
      target: { value: 'review' },
    })
    fireEvent.click(screen.getByRole('button', { name: /review/i }))

    expect(onInsert).toHaveBeenCalledWith('/review ', 'command')
  })

  it('uses the same ranked collision-safe capability selection from the add menu', async () => {
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
    expect(options[1]).toHaveAttribute('aria-disabled', 'true')
    expect(input).toHaveAttribute('aria-controls', screen.getByRole('listbox').id)
    expect(screen.getByRole('listbox').closest('[data-slot="command"]')).not.toBeNull()
    await waitFor(() => expect(options[0]).toHaveAttribute('aria-selected', 'true'))
    expect(screen.queryByText('This Agent has not exposed any skills or commands yet.')).not.toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onCapability).toHaveBeenCalledWith(expect.objectContaining({
      catalogRevision: 5,
      id: 'cap:project:review',
      kind: 'skill',
    }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('moves through enabled capabilities with the official Command keyboard model and accepts with Tab', async () => {
    const onCapability = vi.fn()
    const catalog: ComposerCatalogSnapshot = {
      ...capabilityCatalog,
      items: [
        ...capabilityCatalog.items,
        {
          id: 'cap:project:release', kind: 'skill', name: 'release', description: 'Cut a release',
          source_label: 'Project skill', scope: 'project', input_hint: null,
          enabled: true, disabled_reason: null,
        },
      ],
    }
    render(
      <ComposerAddMenu
        api={{} as KubecodeApi}
        capabilityCatalog={catalog}
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
    const enabled = screen.getAllByRole('option').filter((option) => option.getAttribute('aria-disabled') !== 'true')
    expect(enabled).toHaveLength(2)
    // cmdk highlights the first enabled row; it names it as active once the arrows move.
    await waitFor(() => expect(enabled[0]).toHaveAttribute('aria-selected', 'true'))
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    await waitFor(() => expect(input).toHaveAttribute('aria-activedescendant', enabled[1].id))
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    // Wraps past the disabled row back to the first enabled one.
    await waitFor(() => expect(input).toHaveAttribute('aria-activedescendant', enabled[0].id))
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    await waitFor(() => expect(input).toHaveAttribute('aria-activedescendant', enabled[1].id))
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(onCapability).toHaveBeenCalledWith(expect.objectContaining({ id: enabled[1].getAttribute('data-value') }))
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

  it('offers Project work only when the Session can reference it, and hands back the typed item', async () => {
    const item = {
      ref: { kind: 'finding' as const, id: 'f1', revision: '2' },
      title: 'Accuracy holds',
      summary: 'Pruned model within 1 percent',
      provenance: {
        author: 'agent', updated_at: null, research_id: 'r1', parent: null, state: null,
      },
      availability: 'available' as const,
    }
    const api = {
      searchProjectContext: vi.fn().mockResolvedValue({ items: [item], next_cursor: null, truncated: false }),
    } as unknown as KubecodeApi
    const withoutHandler = render(
      <ComposerAddMenu
        api={api}
        commands={[]}
        conversationId="session-1"
        onInsert={vi.fn()}
        onReference={vi.fn()}
        projectId="project-1"
        t={createTranslator('en')}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    expect(screen.queryByRole('button', { name: /Reference Project work/i })).not.toBeInTheDocument()
    withoutHandler.unmount()

    const onProjectContext = vi.fn()
    render(
      <ComposerAddMenu
        api={api}
        commands={[]}
        conversationId="session-1"
        onInsert={vi.fn()}
        onProjectContext={onProjectContext}
        onReference={vi.fn()}
        projectId="project-1"
        t={createTranslator('en')}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    fireEvent.click(screen.getByRole('button', { name: /Reference Project work/i }))
    const option = await screen.findByRole('option', { name: /Accuracy holds/ })
    expect(screen.getByText(/Referencing or previewing only reads/)).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Search Project work' }), { key: 'Enter' })
    expect(onProjectContext).toHaveBeenCalledWith(item)
    expect(option).toBeDefined()
    // Choosing a reference closes the menu; it started nothing else.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
  it('steps back from an inner panel with Escape instead of closing the whole popover', async () => {
    render(
      <ComposerAddMenu
        api={{} as KubecodeApi}
        commands={[]}
        conversationId="session-1"
        onInsert={vi.fn()}
        onReference={vi.fn()}
        onTerminalContext={vi.fn()}
        projectId="project-1"
        t={createTranslator('en')}
        terminalSources={[{ terminalId: 'terminal-1', paneIndex: 1, selectedText: null }]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    fireEvent.click(screen.getByRole('button', { name: /Reference terminal output/i }))
    const row = screen.getByRole('button', { name: /Attach recent output from Terminal pane 1/i })
    fireEvent.keyDown(row, { key: 'Escape' })
    expect(screen.getByRole('dialog', { name: 'Add context' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Reference terminal output/i })).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Add context' }), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add context' })).not.toBeInTheDocument())
  })

  it('peels the Project work preview inside the real popover before stepping back or closing', async () => {
    const item = {
      ref: { kind: 'finding' as const, id: 'f1', revision: '2' },
      title: 'Accuracy holds',
      summary: 'Pruned model within 1 percent',
      provenance: { author: 'agent', updated_at: null, research_id: 'r1', parent: null, state: null },
      availability: 'available' as const,
    }
    const api = {
      readProjectContext: vi.fn().mockReturnValue(new Promise(() => {})),
      searchProjectContext: vi.fn().mockResolvedValue({ items: [item], next_cursor: null, truncated: false }),
    } as unknown as KubecodeApi
    render(
      <ComposerAddMenu
        api={api}
        commands={[]}
        conversationId="session-1"
        onInsert={vi.fn()}
        onProjectContext={vi.fn()}
        onReference={vi.fn()}
        projectId="project-1"
        t={createTranslator('en')}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    fireEvent.click(screen.getByRole('button', { name: /Reference Project work/i }))
    await screen.findByRole('option', { name: /Accuracy holds/ })
    fireEvent.click(screen.getByRole('button', { name: 'Preview selected' }))
    const search = screen.getByRole('combobox', { name: 'Search Project work' })
    expect(screen.getByRole('region', { name: /preview/i })).toBeInTheDocument()
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: /preview/i })).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Search Project work' })).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Add context' })).toBeInTheDocument()
  })

  it('keeps menu rows touch-sized on coarse pointers', () => {
    render(
      <ComposerAddMenu
        api={{} as KubecodeApi}
        commands={[]}
        conversationId="session-1"
        onInsert={vi.fn()}
        onReference={vi.fn()}
        onTerminalContext={vi.fn()}
        projectId="project-1"
        t={createTranslator('en')}
        terminalSources={[{ terminalId: 'terminal-1', paneIndex: 1, selectedText: null }]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    expect(screen.getByRole('button', { name: /Reference terminal output/i }).className)
      .toContain('pointer-coarse:min-h-11')
  })
})
