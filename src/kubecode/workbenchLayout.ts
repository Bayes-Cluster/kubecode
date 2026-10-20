import { createPreferenceStorage, type PreferenceStorage } from './preferenceStorage'

export const WORKBENCH_LAYOUT_STORAGE_KEY = 'kubecode:workbench-layout:v2'

/** The navigation's layout. Projects are no longer expanded (ADR 0228); what older layouts stored of that is ignored. */
export type WorkbenchNavigatorLayout = {
  /** Whether "History and execution" is open; collapsed unless the researcher opened it. */
  historyOpen: boolean
  navigatorOpen: boolean
  navigatorWidth: number
}

export type ProjectWorkbenchLayout = {
  contextOpen: boolean
  contextWidth: number
  terminalHeight: number
  terminalOpen: boolean
}

const DEFAULT_NAVIGATOR_LAYOUT: WorkbenchNavigatorLayout = {
  historyOpen: false,
  navigatorOpen: true,
  navigatorWidth: 280,
}

const DEFAULT_PROJECT_LAYOUT: ProjectWorkbenchLayout = {
  contextOpen: true,
  contextWidth: 440,
  terminalHeight: 260,
  terminalOpen: false,
}

const navigatorLayoutStorage = createPreferenceStorage<WorkbenchNavigatorLayout, [initialProjectId: string | null]>({
  defaultValue: () => DEFAULT_NAVIGATOR_LAYOUT,
  key: () => WORKBENCH_LAYOUT_STORAGE_KEY,
  migrate: (read, initialProjectId) => {
    const legacy = initialProjectId ? record(read(legacyProjectLayoutKey(initialProjectId))) : null
    return legacy ? {
      historyOpen: DEFAULT_NAVIGATOR_LAYOUT.historyOpen,
      navigatorOpen: booleanValue(legacy.sessionSidebarOpen, DEFAULT_NAVIGATOR_LAYOUT.navigatorOpen),
      navigatorWidth: numericValue(legacy.sessionSidebarWidth, DEFAULT_NAVIGATOR_LAYOUT.navigatorWidth),
    } : undefined
  },
  normalize: (value) => {
    const stored = record(value)
    return stored ? {
      historyOpen: booleanValue(stored.historyOpen, DEFAULT_NAVIGATOR_LAYOUT.historyOpen),
      navigatorOpen: booleanValue(stored.navigatorOpen, DEFAULT_NAVIGATOR_LAYOUT.navigatorOpen),
      navigatorWidth: numericValue(stored.navigatorWidth, DEFAULT_NAVIGATOR_LAYOUT.navigatorWidth),
    } : undefined
  },
})

const projectLayoutStorage = createPreferenceStorage<ProjectWorkbenchLayout, [projectId: string]>({
  defaultValue: () => DEFAULT_PROJECT_LAYOUT,
  key: projectLayoutKey,
  migrate: (read, projectId) => normalizedProjectLayout(read(legacyProjectLayoutKey(projectId))),
  normalize: normalizedProjectLayout,
})

export function readWorkbenchNavigatorLayout(
  storage: PreferenceStorage,
  initialProjectId: string | null,
): WorkbenchNavigatorLayout {
  return navigatorLayoutStorage.read(storage, initialProjectId)
}

export function writeWorkbenchNavigatorLayout(
  storage: PreferenceStorage,
  layout: WorkbenchNavigatorLayout,
): void {
  navigatorLayoutStorage.write(storage, layout, null)
}

export function readProjectWorkbenchLayout(
  storage: PreferenceStorage,
  projectId: string,
): ProjectWorkbenchLayout {
  return projectLayoutStorage.read(storage, projectId)
}

export function writeProjectWorkbenchLayout(
  storage: PreferenceStorage,
  projectId: string,
  layout: ProjectWorkbenchLayout,
): void {
  projectLayoutStorage.write(storage, layout, projectId)
}

function projectLayoutKey(projectId: string): string {
  return `kubecode:project-layout:v2:${projectId}`
}

function legacyProjectLayoutKey(projectId: string): string {
  return `kubecode:layout:${projectId}`
}

function normalizedProjectLayout(value: unknown): ProjectWorkbenchLayout | undefined {
  const stored = record(value)
  return stored ? {
    contextOpen: booleanValue(stored.contextOpen, DEFAULT_PROJECT_LAYOUT.contextOpen),
    contextWidth: numericValue(stored.contextWidth, DEFAULT_PROJECT_LAYOUT.contextWidth),
    terminalHeight: numericValue(stored.terminalHeight, DEFAULT_PROJECT_LAYOUT.terminalHeight),
    terminalOpen: booleanValue(stored.terminalOpen, DEFAULT_PROJECT_LAYOUT.terminalOpen),
  } : undefined
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function numericValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
