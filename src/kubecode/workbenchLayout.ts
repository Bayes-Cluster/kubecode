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

type LayoutStorage = Pick<Storage, 'getItem' | 'setItem'>

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

export function readWorkbenchNavigatorLayout(
  storage: LayoutStorage,
  initialProjectId: string | null,
): WorkbenchNavigatorLayout {
  const stored = readRecord(storage, WORKBENCH_LAYOUT_STORAGE_KEY)
  if (stored) {
    return {
      expandedProjectIds: normalizedProjectIds(stored.expandedProjectIds),
      navigatorOpen: booleanValue(stored.navigatorOpen, DEFAULT_NAVIGATOR_LAYOUT.navigatorOpen),
      navigatorWidth: numericValue(stored.navigatorWidth, DEFAULT_NAVIGATOR_LAYOUT.navigatorWidth),
    }
  }
  const legacy = initialProjectId
    ? readRecord(storage, legacyProjectLayoutKey(initialProjectId))
    : null
  return {
    expandedProjectIds: initialProjectId ? [initialProjectId] : [],
    navigatorOpen: booleanValue(legacy?.sessionSidebarOpen, DEFAULT_NAVIGATOR_LAYOUT.navigatorOpen),
    navigatorWidth: numericValue(legacy?.sessionSidebarWidth, DEFAULT_NAVIGATOR_LAYOUT.navigatorWidth),
  }
}

export function writeWorkbenchNavigatorLayout(
  storage: LayoutStorage,
  layout: WorkbenchNavigatorLayout,
): void {
  writeRecord(storage, WORKBENCH_LAYOUT_STORAGE_KEY, layout)
}

export function readProjectWorkbenchLayout(
  storage: LayoutStorage,
  projectId: string,
): ProjectWorkbenchLayout {
  const stored = readRecord(storage, projectLayoutKey(projectId))
    ?? readRecord(storage, legacyProjectLayoutKey(projectId))
  return {
    contextOpen: booleanValue(stored?.contextOpen, DEFAULT_PROJECT_LAYOUT.contextOpen),
    contextWidth: numericValue(stored?.contextWidth, DEFAULT_PROJECT_LAYOUT.contextWidth),
    terminalHeight: numericValue(stored?.terminalHeight, DEFAULT_PROJECT_LAYOUT.terminalHeight),
    terminalOpen: booleanValue(stored?.terminalOpen, DEFAULT_PROJECT_LAYOUT.terminalOpen),
  }
}

export function writeProjectWorkbenchLayout(
  storage: LayoutStorage,
  projectId: string,
  layout: ProjectWorkbenchLayout,
): void {
  writeRecord(storage, projectLayoutKey(projectId), layout)
}

function projectLayoutKey(projectId: string): string {
  return `kubecode:project-layout:v2:${projectId}`
}

function legacyProjectLayoutKey(projectId: string): string {
  return `kubecode:layout:${projectId}`
}

function readRecord(storage: LayoutStorage, key: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? 'null')
    return value && typeof value === 'object' ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

function writeRecord(storage: LayoutStorage, key: string, value: unknown): void {
  try {
    storage.setItem(key, JSON.stringify(value))
  } catch {
    // Restricted browser contexts can disable local storage.
  }
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
