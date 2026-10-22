import { useSyncExternalStore } from 'react'

// ADR 0246: animations and smooth scrolling honour the system's reduced-motion setting.
const QUERY = '(prefers-reduced-motion: reduce)'

function query(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  return window.matchMedia(QUERY)
}

export function prefersReducedMotion(): boolean {
  return query()?.matches ?? false
}

/** The scroll behaviour to pass to scrollTo and friends. */
export function scrollBehavior(): 'auto' | 'smooth' {
  return prefersReducedMotion() ? 'auto' : 'smooth'
}

function subscribe(onChange: () => void): () => void {
  const list = query()
  list?.addEventListener?.('change', onChange)
  return () => list?.removeEventListener?.('change', onChange)
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false)
}
