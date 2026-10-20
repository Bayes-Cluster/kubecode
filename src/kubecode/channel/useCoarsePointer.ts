import { useSyncExternalStore } from 'react'

const QUERY = '(pointer: coarse)'

function media(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(QUERY) : null
}

function subscribe(listener: () => void) {
  const list = media()
  if (!list) return () => undefined
  list.addEventListener?.('change', listener)
  return () => list.removeEventListener?.('change', listener)
}

/**
 * Whether the primary pointer is a finger. Rows then show one persistent More
 * instead of a hover toolbar, so what assistive technology finds is what is
 * on screen (ADR 0229 §7).
 */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribe, () => media()?.matches ?? false, () => false)
}
