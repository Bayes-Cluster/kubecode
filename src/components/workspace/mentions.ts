/**
 * `@mention` helpers for the shared Composer. A mention is `@handle` at the
 * start of the text or after whitespace; handles are lowercase letters, digits,
 * `_` and `-`. Pure functions, so the rules are tested without a DOM.
 */

import type { MemberRoleKind } from './MemberIdentity'

export type MentionOption = {
  /** Stable id the caller maps to a Session or member. */
  id: string
  handle: string
  label: string
  detail?: string
  /**
   * Who the option is, shown as the shared identity (avatar, name, handle,
   * role in words), and why it cannot receive a message yet, if it cannot.
   */
  identity?: { role: MemberRoleKind; roleLabel?: string; unavailable?: string }
}

const HANDLE_CHARS = 'A-Za-z0-9_-'
const QUERY_PATTERN = new RegExp(`(^|\\s)@([${HANDLE_CHARS}]{0,32})$`)

/** The `@query` being typed right before the caret, if any. */
export function mentionQueryAt(value: string, caret: number): { start: number; query: string } | null {
  const match = QUERY_PATTERN.exec(value.slice(0, caret))
  if (!match) return null
  return { start: caret - match[2].length - 1, query: match[2].toLowerCase() }
}

/**
 * Options matching what was typed, best first: the exact handle, then handles
 * that start with it, then labels that contain it. Ties keep the caller's order.
 */
export function filterMentions(options: MentionOption[], query: string, limit = 8): MentionOption[] {
  const rank = (option: MentionOption): number => {
    const handle = option.handle.toLowerCase()
    if (handle === query) return 0
    if (handle.startsWith(query)) return 1
    if (option.label.toLowerCase().includes(query)) return 2
    return 3
  }
  return options
    .map((option, index) => ({ option, index, rank: rank(option) }))
    .filter((entry) => entry.rank < 3)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.option)
}

/** Replaces the typed `@query` with `@handle ` and says where the caret goes. */
export function insertMention(
  value: string,
  start: number,
  caret: number,
  handle: string,
): { text: string; caret: number } {
  const inserted = `@${handle} `
  return {
    text: `${value.slice(0, start)}${inserted}${value.slice(caret)}`,
    caret: start + inserted.length,
  }
}

/** The options whose `@handle` appears in the text as a whole token. */
export function extractMentions(value: string, options: MentionOption[]): MentionOption[] {
  return options.filter((option) => {
    const pattern = new RegExp(`(^|\\s)@${escapeRegExp(option.handle)}(?![${HANDLE_CHARS}])`, 'i')
    return pattern.test(value)
  })
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
