import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import type { Project } from '../api'
import { WorkbenchTitlebar, type WorkbenchTitlebarProps } from './WorkbenchTitlebar'

const t = createTranslator('en')
const project: Project = { id: 'project-1', name: 'Demo', path: '/demo', workspaces_enabled: false }

function titlebar(overrides: Partial<WorkbenchTitlebarProps> = {}) {
  const handlers = {
    onContextOpenChange: vi.fn(),
    onOpenSession: vi.fn(),
    onRetryConnection: vi.fn(),
    onSessionSidebarOpenChange: vi.fn(),
    onTerminalOpenChange: vi.fn(),
  }
  const view = render(
    <WorkbenchTitlebar
      attentionSessions={[]}
      connectionState="live"
      contextOpen={false}
      conversation={null}
      error={null}
      lastSuccessfulSyncAt={null}
      locale="en"
      narrowLayout={false}
      placeLabel={null}
      project={project}
      projects={[project]}
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
  it('says which Workspace and place is on screen, and searches nothing it cannot name', () => {
    const { container } = titlebar({ placeLabel: 'Kanban' })
    const leading = container.querySelector('.kubecode-topbar-leading')
    expect(leading).toHaveTextContent('Demo/Kanban')
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
        attentionSessions={[]}
        connectionState="live"
        contextOpen={false}
        conversation={null}
        error={null}
        lastSuccessfulSyncAt={null}
        locale="en"
        narrowLayout={false}
        placeLabel={null}
        project={null}
        projects={[]}
        searchSlot={<span>Scoped search</span>}
        sessionSidebarOpen
        t={t}
        terminalOpen={false}
        titlebarTargetRef={() => undefined}
        onContextOpenChange={vi.fn()}
        onOpenSession={vi.fn()}
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
    expect(Array.from(container.querySelectorAll('.kubecode-layout-toggle')).map(
      (button) => button.getAttribute('aria-label'),
    )).toEqual(['Toggle navigation', 'Toggle terminal', 'Toggle context panel'])
    const navigation = screen.getByRole('button', { name: 'Toggle navigation' })
    expect(navigation).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(navigation)
    expect(handlers.onSessionSidebarOpenChange).toHaveBeenCalledWith(false)
  })
})
