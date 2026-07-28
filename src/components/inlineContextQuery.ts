import { chipToken } from './inlineWikilinkTokens'

export type ActiveComposerContextQuery = { start: number; query: string }

export function findActiveComposerContextQuery(
  value: string,
  selectionIndex: number,
): ActiveComposerContextQuery | null {
  const clampedIndex = Math.max(0, Math.min(selectionIndex, value.length))
  const beforeCaret = value.slice(0, clampedIndex)
  const match = /(?:^|\s)@([^\s@]*)$/.exec(beforeCaret)
  if (!match) return null
  const start = clampedIndex - match[1].length - 1
  return { start, query: match[1] }
}

export function replaceActiveComposerContextQuery(
  value: string,
  selectionIndex: number,
  token: string,
): { value: string; nextSelectionIndex: number } | null {
  const active = findActiveComposerContextQuery(value, selectionIndex)
  if (!active) return null
  const replacement = `${chipToken(token)} `
  return {
    value: value.slice(0, active.start) + replacement + value.slice(selectionIndex),
    nextSelectionIndex: active.start + replacement.length,
  }
}
