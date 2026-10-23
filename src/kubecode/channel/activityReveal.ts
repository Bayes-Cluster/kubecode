/** Asks the collapsed activity group around a note to open, so a jump can land on it. */
export const REVEAL_ACTIVITY_EVENT = 'kubecode:reveal-activity'

/** Opens the group holding `target`, synchronously, before the caller scrolls to it. */
export function revealActivity(target: HTMLElement) {
  target.dispatchEvent(new Event(REVEAL_ACTIVITY_EVENT, { bubbles: true }))
}
