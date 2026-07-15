import type { TerminalInfo } from './api'

export type TerminalLayout =
  | { type: 'leaf'; terminalId: string }
  | {
    type: 'split'
    id: string
    direction: 'horizontal' | 'vertical'
    ratio: number
    first: TerminalLayout
    second: TerminalLayout
  }

export type TerminalGroup = {
  id: string
  activeTerminalId: string
  layout: TerminalLayout
}

export type StoredTerminalWorkspaceV2 = {
  version: 2
  activeGroupId: string | null
  groups: TerminalGroup[]
}

export function createTerminalGroup(id: string, terminalId: string): TerminalGroup {
  return { id, activeTerminalId: terminalId, layout: leaf(terminalId) }
}

export function splitTerminalLeaf(
  group: TerminalGroup,
  terminalId: string,
  createdTerminalId: string,
  direction: 'horizontal' | 'vertical',
  splitId: string,
): TerminalGroup {
  return {
    ...group,
    activeTerminalId: createdTerminalId,
    layout: replaceLeaf(group.layout, terminalId, {
      type: 'split',
      id: splitId,
      direction,
      ratio: 50,
      first: leaf(terminalId),
      second: leaf(createdTerminalId),
    }),
  }
}

export function closeTerminalLeaf(group: TerminalGroup, terminalId: string): TerminalGroup | null {
  const layout = removeLeaf(group.layout, terminalId)
  if (!layout) return null
  return {
    ...group,
    activeTerminalId: containsTerminal(layout, group.activeTerminalId)
      ? group.activeTerminalId
      : firstTerminal(layout),
    layout,
  }
}

export function activateTerminalLeaf(group: TerminalGroup, terminalId: string): TerminalGroup {
  return containsTerminal(group.layout, terminalId)
    ? { ...group, activeTerminalId: terminalId }
    : group
}

export function replaceTerminalLeaf(
  group: TerminalGroup,
  terminalId: string,
  replacementTerminalId: string,
): TerminalGroup {
  return {
    ...group,
    activeTerminalId: group.activeTerminalId === terminalId
      ? replacementTerminalId
      : group.activeTerminalId,
    layout: replaceLeaf(group.layout, terminalId, leaf(replacementTerminalId)),
  }
}

export function updateSplitRatio(
  layout: TerminalLayout,
  splitId: string,
  ratio: number,
): TerminalLayout {
  if (layout.type === 'leaf') return layout
  if (layout.id === splitId) return { ...layout, ratio }
  return {
    ...layout,
    first: updateSplitRatio(layout.first, splitId, ratio),
    second: updateSplitRatio(layout.second, splitId, ratio),
  }
}

export function terminalIds(layout: TerminalLayout): string[] {
  return layout.type === 'leaf'
    ? [layout.terminalId]
    : [...terminalIds(layout.first), ...terminalIds(layout.second)]
}

export function readTerminalWorkspace(
  projectId: string,
  terminals: TerminalInfo[],
): StoredTerminalWorkspaceV2 {
  const terminalIdSet = new Set(terminals.map((terminal) => terminal.id))
  const stored = readStoredWorkspace(projectId)
  const restored = stored?.version === 2
    ? restoreVersionTwo(stored, terminalIdSet)
    : restoreLegacy(stored, terminalIdSet)
  return appendUnassignedTerminals(restored, terminals)
}

export function reconcileTerminalWorkspace(
  workspace: StoredTerminalWorkspaceV2,
  terminals: TerminalInfo[],
): StoredTerminalWorkspaceV2 {
  const terminalIdSet = new Set(terminals.map((terminal) => terminal.id))
  const restored = restoreVersionTwo(workspace, terminalIdSet)
  return appendUnassignedTerminals(restored, terminals)
}

function appendUnassignedTerminals(
  restored: StoredTerminalWorkspaceV2,
  terminals: TerminalInfo[],
): StoredTerminalWorkspaceV2 {
  const assigned = new Set(restored.groups.flatMap((group) => terminalIds(group.layout)))
  const groups = [...restored.groups]
  for (const terminal of terminals) {
    if (assigned.has(terminal.id)) continue
    groups.push(createTerminalGroup(groupIdForTerminal(terminal.id), terminal.id))
  }
  const activeGroupId = groups.some((group) => group.id === restored.activeGroupId)
    ? restored.activeGroupId
    : groups[0]?.id ?? null
  return { version: 2, activeGroupId, groups }
}

export function writeTerminalWorkspace(
  projectId: string,
  workspace: StoredTerminalWorkspaceV2,
): void {
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(workspace))
  } catch {
    // Restricted browser contexts can disable local storage.
  }
}

function readStoredWorkspace(projectId: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(projectId)) ?? 'null')
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

function restoreVersionTwo(
  stored: Record<string, unknown>,
  terminalIds: Set<string>,
): StoredTerminalWorkspaceV2 {
  const groups = Array.isArray(stored.groups)
    ? stored.groups.flatMap((value) => sanitizeGroup(value, terminalIds) ?? [])
    : []
  const activeGroupId = typeof stored.activeGroupId === 'string' ? stored.activeGroupId : null
  return { version: 2, activeGroupId, groups }
}

function restoreLegacy(
  stored: Record<string, unknown> | null,
  terminalIds: Set<string>,
): StoredTerminalWorkspaceV2 {
  if (!stored) return { version: 2, activeGroupId: null, groups: [] }
  const layout = sanitizeLayout(stored.layout, terminalIds)
  if (!layout) return { version: 2, activeGroupId: null, groups: [] }
  const savedActive = typeof stored.activeTerminalId === 'string' ? stored.activeTerminalId : null
  const activeTerminalId = savedActive && containsTerminal(layout, savedActive)
    ? savedActive
    : firstTerminal(layout)
  const group = { id: `terminal-group-migrated`, activeTerminalId, layout }
  return { version: 2, activeGroupId: group.id, groups: [group] }
}

function sanitizeGroup(value: unknown, terminalIds: Set<string>): TerminalGroup | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null
  const layout = sanitizeLayout(value.layout, terminalIds)
  if (!layout) return null
  const savedActive = typeof value.activeTerminalId === 'string' ? value.activeTerminalId : null
  return {
    id: value.id,
    activeTerminalId: savedActive && containsTerminal(layout, savedActive)
      ? savedActive
      : firstTerminal(layout),
    layout,
  }
}

function sanitizeLayout(value: unknown, terminalIds: Set<string>): TerminalLayout | null {
  if (!isRecord(value)) return null
  if (value.type === 'leaf') {
    return typeof value.terminalId === 'string' && terminalIds.has(value.terminalId)
      ? leaf(value.terminalId)
      : null
  }
  if (value.type !== 'split') return null
  const first = sanitizeLayout(value.first, terminalIds)
  const second = sanitizeLayout(value.second, terminalIds)
  if (!first) return second
  if (!second) return first
  if (value.direction !== 'horizontal' && value.direction !== 'vertical') return first
  return {
    type: 'split',
    id: typeof value.id === 'string' ? value.id : 'terminal-split-restored',
    direction: value.direction,
    ratio: typeof value.ratio === 'number' && Number.isFinite(value.ratio)
      ? clamp(value.ratio, 1, 99)
      : 50,
    first,
    second,
  }
}

function replaceLeaf(
  layout: TerminalLayout,
  terminalId: string,
  replacement: TerminalLayout,
): TerminalLayout {
  if (layout.type === 'leaf') return layout.terminalId === terminalId ? replacement : layout
  return {
    ...layout,
    first: replaceLeaf(layout.first, terminalId, replacement),
    second: replaceLeaf(layout.second, terminalId, replacement),
  }
}

function removeLeaf(layout: TerminalLayout, terminalId: string): TerminalLayout | null {
  if (layout.type === 'leaf') return layout.terminalId === terminalId ? null : layout
  const first = removeLeaf(layout.first, terminalId)
  const second = removeLeaf(layout.second, terminalId)
  if (!first) return second
  if (!second) return first
  return { ...layout, first, second }
}

function containsTerminal(layout: TerminalLayout, terminalId: string): boolean {
  return layout.type === 'leaf'
    ? layout.terminalId === terminalId
    : containsTerminal(layout.first, terminalId) || containsTerminal(layout.second, terminalId)
}

function firstTerminal(layout: TerminalLayout): string {
  return layout.type === 'leaf' ? layout.terminalId : firstTerminal(layout.first)
}

function leaf(terminalId: string): TerminalLayout {
  return { type: 'leaf', terminalId }
}

function groupIdForTerminal(terminalId: string): string {
  return `terminal-group-${terminalId}`
}

function storageKey(projectId: string): string {
  return `kubecode:terminal-layout:${projectId}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
