import type { TranslationKey } from '@/lib/i18n'

export type HostActionHandlers = {
  addProject: () => void
  focusSessionSearch: () => void
  newSession: () => void
  openSettings: () => void
  toggleContext: () => void
  toggleNavigator: () => void
  toggleTerminal: () => void
}

type HostActionDefinition = {
  id: string
  handler: keyof HostActionHandlers
  labelKey: TranslationKey
  projectRequired?: boolean
}

const HOST_ACTION_DEFINITIONS = [
  { id: 'add-project', handler: 'addProject', labelKey: 'kubecode.addProject' },
  { id: 'new-session', handler: 'newSession', labelKey: 'kubecode.newSession', projectRequired: true },
  { id: 'open-settings', handler: 'openSettings', labelKey: 'kubecode.settings' },
  { id: 'focus-session-search', handler: 'focusSessionSearch', labelKey: 'kubecode.searchSessions' },
  { id: 'toggle-navigator', handler: 'toggleNavigator', labelKey: 'kubecode.toggleSessions' },
  { id: 'toggle-context', handler: 'toggleContext', labelKey: 'kubecode.toggleContext', projectRequired: true },
  { id: 'toggle-terminal', handler: 'toggleTerminal', labelKey: 'kubecode.toggleTerminal', projectRequired: true },
] as const satisfies readonly HostActionDefinition[]

export type HostActionId = typeof HOST_ACTION_DEFINITIONS[number]['id']

export type RegisteredHostAction = {
  disabledReasonKey: TranslationKey | null
  enabled: boolean
  execute: () => void
  id: HostActionId
  labelKey: TranslationKey
}

export function createHostActionRegistry(
  handlers: HostActionHandlers,
  context: { hasProject: boolean },
): RegisteredHostAction[] {
  return HOST_ACTION_DEFINITIONS.map((definition) => {
    const enabled = !('projectRequired' in definition) || context.hasProject
    return {
      disabledReasonKey: enabled ? null : 'kubecode.commandPaletteProjectRequired',
      enabled,
      execute: handlers[definition.handler],
      id: definition.id,
      labelKey: definition.labelKey,
    }
  })
}
