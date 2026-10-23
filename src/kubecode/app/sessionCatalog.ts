import type { Conversation } from '../api'

export function upsertConversation(current: Conversation[], conversation: Conversation): Conversation[] {
  const existing = current.find((item) => item.id === conversation.id)
  const updated = existing ? { ...existing, ...conversation } : conversation
  return [...current.filter((item) => item.id !== conversation.id), updated]
}

export function mergeConversations(...groups: Conversation[][]): Conversation[] {
  const merged = new Map<string, Conversation>()
  for (const group of groups) {
    for (const conversation of group) merged.set(conversation.id, conversation)
  }
  return [...merged.values()]
}

/**
 * A list reload keeps the selected Session while the list still holds it, or
 * while it is the member run opened from a Task that the list leaves out (#254).
 */
export function keepsSelection(
  selected: string | null,
  listed: readonly { id: string }[],
  held: string | null | undefined,
): boolean {
  return selected !== null && (selected === held || listed.some((item) => item.id === selected))
}
