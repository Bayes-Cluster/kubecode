import { type RefObject, useLayoutEffect } from 'react'

/**
 * ADR 0257, slice D: the decision prompts' focus contract, shared by every
 * card — where focus goes when a prompt holding it goes away, and how an
 * answer's focus rides a morph.
 */

/**
 * When the prompt holding focus goes (answered, timed out), focus moves to
 * the next decision prompt, or else the composer, instead of falling to
 * <body>.
 */
export function useFocusHandoff(rootRef: RefObject<HTMLElement | null>, focusKeyPrefix: string) {
  useLayoutEffect(() => {
    const root = rootRef.current
    return () => {
      if (!root || !root.contains(document.activeElement)) return
      const doc = root.ownerDocument
      window.setTimeout(() => {
        if (doc.activeElement && doc.activeElement !== doc.body) return
        const next = Array.from(doc.querySelectorAll<HTMLElement>(`[data-focus-key^="${focusKeyPrefix}:"]`)).find((node) => node !== root && node.isConnected)
        const target = next ?? doc.querySelector<HTMLElement>('.kubecode-composer-textarea')
        target?.focus()
      }, 0)
    }
  }, [rootRef, focusKeyPrefix])
}

/** Answers focus inside the card's buttons: ride the root through any morph. */
export function rideFocusThrough(rootRef: RefObject<HTMLElement | null>) {
  if (rootRef.current?.contains(document.activeElement)
    && document.activeElement instanceof HTMLButtonElement) {
    rootRef.current.focus()
  }
}
