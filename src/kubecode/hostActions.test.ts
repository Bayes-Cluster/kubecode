import { describe, expect, it, vi } from 'vitest'

import { createHostActionRegistry, type HostActionHandlers } from './hostActions'

function handlers(): HostActionHandlers {
  return {
    addProject: vi.fn(),
    focusSessionSearch: vi.fn(),
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

  it('executes only the local handler attached to the selected host action', () => {
    const localHandlers = handlers()
    const registered = createHostActionRegistry(localHandlers, { hasProject: true })

    registered.find((action) => action.id === 'toggle-terminal')?.execute()

    expect(localHandlers.toggleTerminal).toHaveBeenCalledOnce()
    expect(localHandlers.newSession).not.toHaveBeenCalled()
  })
})
