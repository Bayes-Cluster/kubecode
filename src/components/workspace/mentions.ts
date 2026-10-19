/**
 * `@mention` helpers for the shared Composer. A mention is `@handle` at the
 * start of the text or after whitespace; handles are lowercase letters, digits,
 * `_` and `-`. Pure functions, so the rules are tested without a DOM.
 */

export type MentionOption = {
  /** Stable id the caller maps to a Session or member. */
  id: string
  handle: string
  label: string
  detail?: string
}

const HANDLE_CHARS = 'A-Za-z0-9_-'
const QUERY_PATTERN = new RegExp(`(^|\\s)@([${HANDLE_CHARS}]{0,32})$`)

/** The `@query` being typed right before the caret, if any. */
export function mentionQueryAt(value: string, caret: number): { start: number; query: string } | null {
  const match = QUERY_PATTERN.exec(value.slice(0, caret))
  if (!match) return null
  return { start: caret - match[2].length - 1, query: match[2].toLowerCase() }
}

export function filterMentions(options: MentionOption[], query: string, limit = 8): MentionOption[] {
  return options
    .filter((option) => (
      option.handle.startsWith(query) || option.label.toLowerCase().includes(query)
    ))
    .slice(0, limit)
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
