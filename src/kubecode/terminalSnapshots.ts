export type TerminalViewSnapshot = {
  buffer: string
  cols: number
  cursor: number
  rows: number
  scrollY: number
}

export function readTerminalSnapshot(
  projectId: string,
  terminalId: string,
): TerminalViewSnapshot | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(snapshotKey(projectId, terminalId)) ?? 'null')
    if (!isRecord(value)) return null
    if (typeof value.buffer !== 'string') return null
    const cols = validNumber(value.cols)
    const cursor = validNumber(value.cursor)
    const rows = validNumber(value.rows)
    const scrollY = validNumber(value.scrollY)
    if (cols === null || cursor === null || rows === null || scrollY === null) return null
    return { buffer: value.buffer, cols, cursor, rows, scrollY }
  } catch {
    return null
  }
}

export function writeTerminalSnapshot(
  projectId: string,
  terminalId: string,
  snapshot: TerminalViewSnapshot,
): void {
  try {
    sessionStorage.setItem(snapshotKey(projectId, terminalId), JSON.stringify(snapshot))
  } catch {
    // A server-side replay remains available when browser storage is unavailable or full.
  }
}

export function removeTerminalSnapshot(projectId: string, terminalId: string): void {
  try {
    sessionStorage.removeItem(snapshotKey(projectId, terminalId))
  } catch {
    // Restricted browser contexts can disable session storage.
  }
}

function snapshotKey(projectId: string, terminalId: string): string {
  return `kubecode:terminal-snapshot:${projectId}:${terminalId}`
}

function validNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
