import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import type { Project } from '../api'
import { WorkbenchTitlebar, type WorkbenchTitlebarProps } from './WorkbenchTitlebar'

const t = createTranslator('en')
const project: Project = { id: 'project-1', name: 'Demo', path: '/demo', workspaces_enabled: false }

function titlebar(overrides: Partial<WorkbenchTitlebarProps> = {}) {
  const handlers = {
    onContextOpenChange: vi.fn(),
    onOpenTarget: vi.fn(),
    onOpenWorkspaceNeeds: vi.fn(),
    onRetryConnection: vi.fn(),
    onSessionSidebarOpenChange: vi.fn(),
    onTerminalOpenChange: vi.fn(),
  }
  const view = render(
    <WorkbenchTitlebar
      attention={{ current: [], others: [], total: 0 }}
      connectionState="live"
      contextOpen={false}
      conversation={null}
      error={null}
      lastSuccessfulSyncAt={null}
      locale="en"
      narrowLayout={false}
      placeLabel={null}
      project={project}
      sessionSidebarOpen
      t={t}
      terminalOpen={false}
      titlebarTargetRef={() => undefined}
      {...handlers}
      {...overrides}
    />,
  )
  return { ...view, handlers }
}

describe('WorkbenchTitlebar', () => {
  it('has one bell for what needs the researcher in every Workspace, and opens each where it is decided', async () => {
    const entry = {
      key: 'permission:q1',
      title: 'Analyst wants to use pytest',
      reason: { label: 'Permission', tone: 'warn' as const },
      target: { place: { view: 'general' as const }, focus: 'permission:q1' },
    }
    const { handlers } = titlebar({
      attention: { current: [entry], others: [{ projectId: 'project-2', name: 'Other', count: 2 }], total: 3 },
    })
    const bell = screen.getByRole('button', { name: 'Needs you: 3' })
    fireEvent.pointerDown(bell, { button: 0, ctrlKey: false })
    expect(await screen.findByText('This Workspace')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: /Analyst wants to use pytest/ }))
    // It opens once the menu has closed, so the menu cannot keep or return focus.
    await waitFor(() => expect(handlers.onOpenTarget).toHaveBeenCalledWith(entry.target))
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Needs you: 3' }), { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Other: 2' }))
    expect(handlers.onOpenWorkspaceNeeds).toHaveBeenCalledWith('project-2')
  })

  it('lists five of this Workspace\'s decisions, and shows all of them in Needs you on request', async () => {
    const entries = Array.from({ length: 7 }, (_, index) => ({
      key: `question:d${index}`,
      title: `Question ${index}`,
      reason: { label: 'Question', tone: 'warn' as const },
      target: { place: { view: 'board' as const }, focus: `question:d${index}` },
    }))
    const { handlers } = titlebar({ attention: { current: entries, others: [], total: 7 } })
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Needs you: 7' }), { button: 0, ctrlKey: false })
    expect(await screen.findAllByRole('menuitem', { name: /^Question \d/ })).toHaveLength(5)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show all 7 in Needs you' }))
    expect(handlers.onOpenWorkspaceNeeds).toHaveBeenCalledWith('project-1')
  })

  it('leaves focus to the decision it opened, never back on the bell', async () => {
    const entry = {
      key: 'permission:q1',
      title: 'Analyst wants to use pytest',
      reason: { label: 'Permission', tone: 'warn' as const },
      target: { place: { view: 'general' as const }, focus: 'permission:q1' },
    }
    titlebar({ attention: { current: [entry], others: [], total: 1 } })
    const bell = screen.getByRole('button', { name: 'Needs you: 1' })
    bell.focus()
    fireEvent.pointerDown(bell, { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Analyst wants to use pytest/ }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(bell).not.toHaveFocus()
  })

  it('shows no bell when nothing waits', () => {
    titlebar()
    expect(screen.queryByRole('button', { name: /^Needs you: / })).not.toBeInTheDocument()
  })

  it('says which Workspace and place is on screen, and searches nothing it cannot name', () => {
    const { container } = titlebar({ placeLabel: 'Kanban' })
    const leading = container.querySelector('.kubecode-topbar-leading')
    const breadcrumb = screen.getByRole('navigation', { name: 'Location' })
    expect(leading).toContainElement(breadcrumb)
    expect(breadcrumb).toHaveTextContent('DemoKanban')
    expect(screen.getByText('Kanban')).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByRole('textbox', { name: 'Search Sessions in all Workspaces' })).not.toBeInTheDocument()
  })

  it('shows only the place on a phone', () => {
    const { container } = titlebar({ narrowLayout: true, placeLabel: 'General' })
    const leading = container.querySelector('.kubecode-topbar-leading')
    expect(leading).toHaveTextContent('General')
    expect(leading).not.toHaveTextContent('Demo')
  })

  it('leaves the Sessions surface its own title, and names the Workspace before one is chosen', () => {
    const { container, rerender } = titlebar()
    expect(container.querySelector('.kubecode-topbar-leading')).toHaveTextContent('Demo')
    rerender(
      <WorkbenchTitlebar
        attention={{ current: [], others: [], total: 0 }}
        connectionState="live"
        contextOpen={false}
        conversation={null}
        error={null}
        lastSuccessfulSyncAt={null}
        locale="en"
        narrowLayout={false}
        placeLabel={null}
        project={null}
        searchSlot={<span>Scoped search</span>}
        sessionSidebarOpen
        t={t}
        terminalOpen={false}
        titlebarTargetRef={() => undefined}
        onContextOpenChange={vi.fn()}
        onOpenTarget={vi.fn()}
        onOpenWorkspaceNeeds={vi.fn()}
        onRetryConnection={vi.fn()}
        onSessionSidebarOpenChange={vi.fn()}
        onTerminalOpenChange={vi.fn()}
      />,
    )
    expect(container.querySelector('.kubecode-topbar-leading')).toHaveTextContent('Kubecode')
    expect(screen.getByText('Scoped search')).toBeInTheDocument()
  })

  it('toggles the navigation, the terminal, and the context panel in that order', () => {
    const { container, handlers } = titlebar()
    expect(Array.from(container.querySelectorAll('[data-slot="toggle"]')).map(
      (button) => button.getAttribute('aria-label'),
    )).toEqual(['Toggle navigation', 'Toggle terminal', 'Toggle context panel'])
    const navigation = screen.getByRole('button', { name: 'Toggle navigation' })
    expect(navigation).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(navigation)
    expect(handlers.onSessionSidebarOpenChange).toHaveBeenCalledWith(false)
  })

  it('draws each execution tool with its own glyph and names it on hover', () => {
    const { container } = titlebar()
    const toggles = Array.from(container.querySelectorAll('[data-slot="toggle"]'))
    expect(toggles.map((button) => button.querySelector('svg')?.getAttribute('class'))).toEqual([
      expect.stringContaining('lucide-panel-left'),
      expect.stringContaining('lucide-square-terminal'),
      expect.stringContaining('lucide-folder-git'),
    ])
    expect(toggles.map((button) => button.getAttribute('title'))).toEqual(['Toggle navigation', 'Toggle terminal', 'Toggle context panel'])
  })

  it('reports a global error as a destructive badge that names it', () => {
    titlebar({ error: 'Could not reach the server' })
    const status = screen.getByRole('status', { name: 'Could not reach the server' })
    expect(status).toHaveAttribute('data-variant', 'destructive')
  })

  it('lists the runtime connection state as menu items, not loose rows', async () => {
    titlebar({ connectionState: 'reconnecting' })
    fireEvent.pointerDown(screen.getByRole('button', { name: /Runtime connection/ }), { button: 0, ctrlKey: false })
    expect(await screen.findByRole('menuitem', { name: /Retry/ })).toBeInTheDocument()
    expect(document.querySelector('.kubecode-connection-row')).toBeNull()
  })
})
