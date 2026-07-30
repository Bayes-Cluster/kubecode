import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import type { ComposerCatalogSnapshot } from './api'
import { GlobalCommandPalette } from './GlobalCommandPalette'
import { createHostActionRegistry, type HostActionHandlers } from './hostActions'

const catalog: ComposerCatalogSnapshot = {
  conversation_id: 'session-1', revision: 4, contexts: [],
  items: [
    {
      id: 'cmd:review', kind: 'command', name: 'review', description: 'Review changes',
      source_label: 'Codex command', scope: 'session', input_hint: null,
      enabled: true, disabled_reason: null,
    },
    {
      id: 'cap:project:test', kind: 'skill', name: 'test', description: 'Run focused tests',
      source_label: 'Project skill', scope: 'project', input_hint: null,
      enabled: true, disabled_reason: null,
    },
  ],
}

function hostActions() {
  const noop = vi.fn()
  const handlers: HostActionHandlers = {
    addProject: noop,
    focusSessionSearch: noop,
    newSession: noop,
    openSettings: noop,
    toggleContext: noop,
    toggleNavigator: noop,
    toggleTerminal: noop,
  }
  return createHostActionRegistry(handlers, { hasProject: true })
}

describe('GlobalCommandPalette', () => {
  it('renders accessible grouped rows with provenance and skips disabled rows with the keyboard', () => {
    const onCatalogItem = vi.fn()
    render(
      <GlobalCommandPalette
        catalog={catalog}
        catalogStatus="ready"
        hostActions={hostActions()}
        onCatalogItem={onCatalogItem}
        onHostAction={vi.fn()}
        onOpenChange={vi.fn()}
        open
        sessionDisabledReason="No writable compatible Session is active."
        sessionWritable={false}
        t={createTranslator('en')}
      />,
    )

    const input = screen.getByRole('combobox', { name: 'Type a command...' })
    const listbox = screen.getByRole('listbox')
    expect(screen.getByRole('dialog', { name: 'Command Palette' }))
      .toHaveClass('w-[min(44rem,calc(100vw-1rem))]')
    expect(input).toHaveAttribute('aria-controls', listbox.id)
    expect(screen.getByRole('group', { name: 'Host actions' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Agent commands' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Skills and capabilities' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /review/i })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('option', { name: /review/i })).toHaveAttribute('tabindex', '-1')
    expect(screen.getByRole('option', { name: /review/i })).toHaveTextContent('Codex command')
    expect(screen.getByRole('option', { name: /test/i })).toHaveTextContent('Project')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCatalogItem).not.toHaveBeenCalled()
  })

  it('filters with shared ranking and selects enabled catalog rows by keyboard and touch', () => {
    const onCatalogItem = vi.fn()
    const { rerender } = render(
      <GlobalCommandPalette
        catalog={catalog}
        catalogStatus="ready"
        hostActions={[]}
        onCatalogItem={onCatalogItem}
        onHostAction={vi.fn()}
        onOpenChange={vi.fn()}
        open
        sessionDisabledReason={null}
        sessionWritable
        t={createTranslator('en')}
      />,
    )
    const input = screen.getByRole('combobox', { name: 'Type a command...' })
    fireEvent.change(input, { target: { value: 'test' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCatalogItem).toHaveBeenCalledWith(expect.objectContaining({ id: 'cap:project:test' }))

    onCatalogItem.mockClear()
    rerender(
      <GlobalCommandPalette
        catalog={{ ...catalog, revision: 5, items: [catalog.items[0]] }}
        catalogStatus="ready"
        hostActions={[]}
        onCatalogItem={onCatalogItem}
        onHostAction={vi.fn()}
        onOpenChange={vi.fn()}
        open
        sessionDisabledReason={null}
        sessionWritable
        t={createTranslator('en')}
      />,
    )
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'review' } })
    const option = screen.getByRole('option', { name: /review/i })
    fireEvent.pointerDown(option, { pointerType: 'touch' })
    fireEvent.click(option)
    expect(onCatalogItem).toHaveBeenCalledWith(expect.objectContaining({ id: 'cmd:review' }))
    expect(within(screen.getByRole('dialog')).queryByText('test')).not.toBeInTheDocument()
  })

  it('shows catalog loading and error states without exposing stale rows', () => {
    const { rerender } = render(
      <GlobalCommandPalette
        catalog={null}
        catalogStatus="loading"
        hostActions={hostActions()}
        onCatalogItem={vi.fn()}
        onHostAction={vi.fn()}
        onOpenChange={vi.fn()}
        open
        sessionDisabledReason="No writable compatible Session is active."
        sessionWritable={false}
        t={createTranslator('en')}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Loading capabilities')

    rerender(
      <GlobalCommandPalette
        catalog={null}
        catalogStatus="error"
        hostActions={hostActions()}
        onCatalogItem={vi.fn()}
        onHostAction={vi.fn()}
        onOpenChange={vi.fn()}
        open
        sessionDisabledReason="No writable compatible Session is active."
        sessionWritable={false}
        t={createTranslator('en')}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Could not load capabilities')
  })
})
