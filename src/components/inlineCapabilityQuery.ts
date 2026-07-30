import { chipToken } from './inlineWikilinkTokens'

export type ActiveComposerCapabilityQuery = {
  query: string
  start: number
  trigger: '$' | '＄' | '¥' | '￥'
}

export function findActiveComposerCapabilityQuery(
  value: string,
  selectionIndex: number,
): ActiveComposerCapabilityQuery | null {
  const clampedIndex = Math.max(0, Math.min(selectionIndex, value.length))
  const beforeCaret = value.slice(0, clampedIndex)
  const match = /(?:^|\s)([$＄¥￥])([^\s$＄¥￥]*)$/.exec(beforeCaret)
  if (!match) return null
  const trigger = match[1] as ActiveComposerCapabilityQuery['trigger']
  const query = match[2]
  return { query, start: clampedIndex - query.length - trigger.length, trigger }
}

export function replaceActiveComposerCapabilityQuery(
  value: string,
  selectionIndex: number,
  token: string,
): { value: string; nextSelectionIndex: number } | null {
  const active = findActiveComposerCapabilityQuery(value, selectionIndex)
  if (!active) return null
  const replacement = `${chipToken(token)} `
  return {
    value: value.slice(0, active.start) + replacement + value.slice(selectionIndex),
    nextSelectionIndex: active.start + replacement.length,
  }
}
