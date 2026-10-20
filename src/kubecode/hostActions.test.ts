import { describe, expect, it, vi } from 'vitest'

import { createHostActionRegistry, type HostActionHandlers } from './hostActions'

function handlers(): HostActionHandlers {
  return {
    addProject: vi.fn(),
    focusSessionSearch: vi.fn(),
    searchWorkspace: vi.fn(),
    newSession: vi.fn(),
    openSettings: vi.fn(),
    toggleContext: vi.fn(),
    toggleNavigator: vi.fn(),
    toggleTerminal: vi.fn(),
  }
}

describe('host action registry', () => {
  it('registers a stable typed set and disables Project-scoped actions without a Project', () => {
    const registered = createHostActionRegistry(handlers(), { hasProject: false })

    expect(registered.map((action) => action.id)).toEqual([
      'add-project',
      'new-session',
      'open-settings',
      'focus-session-search',
      'search-workspace',
      'toggle-navigator',
      'toggle-context',
      'toggle-terminal',
    ])
    expect(registered.find((action) => action.id === 'new-session')).toMatchObject({
      disabledReasonKey: 'kubecode.commandPaletteProjectRequired',
      enabled: false,
    })
    expect(registered.find((action) => action.id === 'open-settings')?.enabled).toBe(true)
  })

  it('searches the Workspace apart from Session search, only with a Workspace open', () => {
    const local = handlers()
    const without = createHostActionRegistry(local, { hasProject: false })
    expect(without.find((action) => action.id === 'search-workspace')).toMatchObject({
      enabled: false, labelKey: 'kubecode.search.searchWorkspace',
    })
    createHostActionRegistry(local, { hasProject: true }).find((action) => action.id === 'search-workspace')?.execute()
    expect(local.searchWorkspace).toHaveBeenCalledOnce()
    expect(local.focusSessionSearch).not.toHaveBeenCalled()
  })

  it('names the left panel for what it holds: the navigation', () => {
    const registered = createHostActionRegistry(handlers(), { hasProject: true })

    expect(registered.find((action) => action.id === 'toggle-navigator')?.labelKey).toBe('kubecode.toggleNavigation')
  })

  it('executes only the local handler attached to the selected host action', () => {
    const localHandlers = handlers()
    const registered = createHostActionRegistry(localHandlers, { hasProject: true })

    registered.find((action) => action.id === 'toggle-terminal')?.execute()

    expect(localHandlers.toggleTerminal).toHaveBeenCalledOnce()
    expect(localHandlers.newSession).not.toHaveBeenCalled()
  })
})
