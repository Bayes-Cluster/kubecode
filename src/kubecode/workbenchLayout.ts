import { createPreferenceStorage, type PreferenceStorage } from './preferenceStorage'

export const WORKBENCH_LAYOUT_STORAGE_KEY = 'kubecode:workbench-layout:v2'

export type WorkbenchNavigatorLayout = {
  expandedProjectIds: string[]
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
  expandedProjectIds: [],
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
  defaultValue: (initialProjectId) => defaultNavigatorLayout(initialProjectId),
  key: () => WORKBENCH_LAYOUT_STORAGE_KEY,
  migrate: (read, initialProjectId) => {
    const legacy = initialProjectId ? record(read(legacyProjectLayoutKey(initialProjectId))) : null
    return legacy ? {
      expandedProjectIds: initialProjectId ? [initialProjectId] : [],
      navigatorOpen: booleanValue(legacy.sessionSidebarOpen, DEFAULT_NAVIGATOR_LAYOUT.navigatorOpen),
      navigatorWidth: numericValue(legacy.sessionSidebarWidth, DEFAULT_NAVIGATOR_LAYOUT.navigatorWidth),
    } : undefined
  },
  normalize: (value) => {
    const stored = record(value)
    return stored ? {
      expandedProjectIds: normalizedProjectIds(stored.expandedProjectIds),
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

function defaultNavigatorLayout(initialProjectId: string | null): WorkbenchNavigatorLayout {
  return {
    ...DEFAULT_NAVIGATOR_LAYOUT,
    expandedProjectIds: initialProjectId ? [initialProjectId] : [],
  }
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

function normalizedProjectIds(value: unknown): string[] {
  if (!Array.isArray(value)) return DEFAULT_NAVIGATOR_LAYOUT.expandedProjectIds
  return [...new Set(value.filter((item): item is string => (
    typeof item === 'string' && item.trim().length > 0
  )))]
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function numericValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
