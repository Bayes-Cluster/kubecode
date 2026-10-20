import { createRef } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import type { Conversation, KubecodeApi, Project } from '../api'
import { ProjectNavigator, type ProjectNavigatorProps } from './ProjectNavigator'

const t = createTranslator('en')

const projects: Project[] = [
  { id: 'project-1', name: 'Demo', path: '/demo', workspaces_enabled: false },
  { id: 'project-2', name: 'Other', path: '/other', workspaces_enabled: false },
]

const session = (id: string, title: string, projectId = 'project-1') => ({
  id, project_id: projectId, agent_id: 'codex', provider_session_id: null, title, manual_title: null,
  agent_title: title, created_at: '2026-07-16T06:00:00Z', updated_at: '2026-07-16T06:00:00Z',
  latest_run_status: 'completed',
}) as Conversation

function navigator(overrides: Partial<ProjectNavigatorProps> = {}) {
  const handlers = {
    onAddProject: vi.fn(),
    onConversationCreated: vi.fn(),
    onConversationRemoved: vi.fn(),
    onConversationUpdated: vi.fn(),
    onError: vi.fn(),
    onHistoryOpenChange: vi.fn(),
    onNewSession: vi.fn(),
    onOpenSettings: vi.fn(),
    onProjectDelete: vi.fn(),
    onProjectWorkspacesToggle: vi.fn(),
    onQueryChange: vi.fn(),
    onResize: vi.fn(),
    onSelect: vi.fn(),
    onWorkspaceSelect: vi.fn(),
  }
  const searchRef = createRef<HTMLInputElement>()
  const view = render(
    <ProjectNavigator
      activeConversationId={null}
      activeProjectId="project-1"
      api={{} as KubecodeApi}
      conversations={[session('s1', 'Earlier chat'), session('s2', 'Elsewhere chat', 'project-2')]}
      historyOpen={false}
      historySection={<p>Threads and questions</p>}
      navigatorWidth={280}
      projectRuns={{}}
      projects={projects}
      query=""
      searchRef={searchRef}
      t={t}
      teams={[]}
      workspaceSection={<section aria-label="Workspace">Places</section>}
      {...handlers}
      {...overrides}
    />,
  )
  return { ...view, handlers, searchRef }
}

describe('ProjectNavigator', () => {
  beforeEach(() => localStorage.clear())

  it('is the Workspaces navigation: the Workspaces, this Workspace’s places, then its history', () => {
    const { container, handlers } = navigator()
    const nav = screen.getByRole('navigation', { name: 'Workspaces' })
    expect(within(nav).getByText('Workspaces', { selector: 'strong' })).toBeInTheDocument()
    fireEvent.click(within(nav).getByRole('button', { name: 'Add project' }))
    expect(handlers.onAddProject).toHaveBeenCalled()

    const list = within(nav).getByRole('list', { name: 'Workspaces' })
    const places = within(nav).getByRole('region', { name: 'Workspace' })
    const history = container.querySelector('details.kubecode-history-nav') as HTMLDetailsElement
    expect(list.compareDocumentPosition(places) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(places.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.click(within(list).getByRole('button', { name: 'Other' }))
    expect(handlers.onWorkspaceSelect).toHaveBeenCalledWith('project-2')
  })

  it('keeps execution history collapsed, holding the search, this Workspace’s Sessions, and the older threads', () => {
    const { container, handlers, searchRef } = navigator()
    const history = container.querySelector('details.kubecode-history-nav') as HTMLDetailsElement
    expect(history.open).toBe(false)
    expect(within(history).getByText('History and execution', { selector: 'summary' })).toBeInTheDocument()
    const search = within(history).getByRole('textbox', { name: 'Search sessions' })
    expect(searchRef.current).toBe(search)
    expect(within(history).getByRole('button', { name: 'Earlier chat' })).toBeInTheDocument()
    expect(within(history).queryByRole('button', { name: 'Elsewhere chat' })).not.toBeInTheDocument()
    expect(within(history).getByText('Threads and questions')).toBeInTheDocument()
    // The Workspace rows stay the only controls named after a Project.
    expect(screen.getAllByRole('button', { name: 'Demo' })).toHaveLength(1)

    fireEvent.change(search, { target: { value: 'chat' } })
    expect(handlers.onQueryChange).toHaveBeenCalledWith('chat')
    fireEvent.click(within(history).getByRole('button', { name: 'Earlier chat' }))
    expect(handlers.onSelect).toHaveBeenCalledWith('project-1', 's1')
    fireEvent.click(within(history).getByRole('button', { name: 'New session' }))
    expect(handlers.onNewSession).toHaveBeenCalledWith('project-1')
  })

  it('reports the researcher opening and closing execution history', () => {
    const { container, handlers, rerender } = navigator()
    const history = container.querySelector('details.kubecode-history-nav') as HTMLDetailsElement
    history.open = true
    fireEvent(history, new Event('toggle'))
    expect(handlers.onHistoryOpenChange).toHaveBeenLastCalledWith(true)
    rerender(
      <ProjectNavigator
        activeConversationId={null}
        activeProjectId="project-1"
        api={{} as KubecodeApi}
        conversations={[]}
        historyOpen
        navigatorWidth={280}
        projectRuns={{}}
        projects={projects}
        query=""
        searchRef={createRef()}
        t={t}
        teams={[]}
        {...handlers}
      />,
    )
    expect(history.open).toBe(true)
  })

  it('searches every Workspace’s Sessions under plain headings', () => {
    navigator({ query: 'chat' })
    const nav = screen.getByRole('navigation', { name: 'Workspaces' })
    expect(within(nav).getByRole('heading', { name: 'Other', level: 3 })).toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: 'Elsewhere chat' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Other' })).toHaveLength(1)
  })

  it('names each Workspace’s run state from its runs', () => {
    navigator({
      projectRuns: {
        'project-2': [{ conversation_id: 's2', status: 'waiting_permission' }] as never,
      },
    })
    expect(screen.getByRole('button', { name: 'Other' })).toHaveAttribute('data-session-status', 'stuck')
  })
})
