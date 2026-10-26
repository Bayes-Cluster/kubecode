import { useCallback, useLayoutEffect, useRef } from 'react'

import { prefersReducedMotion } from '@/lib/reducedMotion'

/**
 * ADR 0257 §5: the shared FLIP contract — this is the motion contract
 * utility, not a recreation of a catalog entry. Read first geometry before a
 * known commit, re-measure after it inside `useLayoutEffect`, invert with a
 * transform and animate to identity with WAAPI, so the browser cancels and
 * retargets an interrupted run. Never measure during render; lists opt in per
 * item with stable keys; reduced motion applies the final state immediately
 * (a null animation and no transform left behind).
 */

export interface FlipRect {
  x: number
  y: number
  width: number
  height: number
}

export interface FlipOptions {
  duration?: number
  easing?: string
  /** Injected by tests; production reads live boxes. */
  measure?: (element: Element) => FlipRect
}

export const FLIP_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'
export const FLIP_DURATION = 260

export function readRect(element: Element): FlipRect {
  const rect = element.getBoundingClientRect()
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

function deltaBetween(first: FlipRect, last: FlipRect) {
  const dx = first.x - last.x
  const dy = first.y - last.y
  const sx = last.width === 0 ? 1 : first.width / last.width
  const sy = last.height === 0 ? 1 : first.height / last.height
  return { dx, dy, sx, sy }
}

export function isSettled({ dx, dy, sx, sy }: ReturnType<typeof deltaBetween>): boolean {
  return Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.001 && Math.abs(sy - 1) < 0.001
}

/**
 * Invert `element` from `first` to its current box and play it to identity.
 * Returns null when motion is reduced or the element did not move; the
 * element's own style is never mutated, so cancelling leaves it settled.
 */
export function playFlip(
  element: HTMLElement,
  first: FlipRect,
  options: FlipOptions = {},
  measure: (element: Element) => FlipRect = readRect,
): Animation | null {
  if (prefersReducedMotion()) return null
  const delta = deltaBetween(first, measure(element))
  if (isSettled(delta)) return null
  return element.animate(
    [
      {
        transform: `translate(${delta.dx}px, ${delta.dy}px) scale(${delta.sx}, ${delta.sy})`,
        transformOrigin: '0 0',
      },
      { transform: 'none', transformOrigin: '0 0' },
    ],
    {
      duration: options.duration ?? FLIP_DURATION,
      easing: options.easing ?? FLIP_EASING,
    },
  )
}

/**
 * Per-item FLIP for a keyed list. Call the returned registration as a ref
 * callback for every item; pass the list's identity (the item key array) as
 * the dependency. After each commit where the list changed, items seen in
 * both the previous and the current list animate from their previous box;
 * entering items appear settled; leaving items simply disappear.
 */
export function useFlipGroup(
  listKey: readonly unknown[],
  options: FlipOptions = {},
): (key: string) => (element: HTMLElement | null) => void {
  const firstBoxes = useRef(new Map<string, FlipRect>())
  const elements = useRef(new Map<string, HTMLElement>())
  const runningRef = useRef(new Set<Animation>())
  const mounted = useRef(false)
  // The trigger is the list's identity alone, so streamed updates that keep
  // the key list stable measure nothing; the options ride along in a ref.
  const optionsRef = useRef(options)
  useLayoutEffect(() => {
    optionsRef.current = options
  }, [options])
  const measure = useCallback(
    (element: Element) => (optionsRef.current.measure ?? readRect)(element),
    [],
  )

  useLayoutEffect(() => {
    if (mounted.current) {
      const reduced = prefersReducedMotion()
      const running = runningRef.current
      for (const animation of running) animation.cancel()
      running.clear()
      if (!reduced) {
        for (const [key, element] of elements.current) {
          const first = firstBoxes.current.get(key)
          if (!first) continue
          const animation = playFlip(element, first, optionsRef.current, measure)
          if (!animation) continue
          running.add(animation)
          animation.finished.then(
            () => running.delete(animation),
            () => running.delete(animation),
          )
        }
      }
    }
    mounted.current = true
    firstBoxes.current.clear()
    for (const [key, element] of elements.current) {
      firstBoxes.current.set(key, measure(element))
    }
  }, [listKey, measure])

  useLayoutEffect(
    () => () => {
      for (const animation of runningRef.current) animation.cancel()
      runningRef.current.clear()
      elements.current.clear()
      firstBoxes.current.clear()
    },
    [],
  )

  return (key: string) => (element: HTMLElement | null) => {
    if (element) elements.current.set(key, element)
    else elements.current.delete(key)
  }
}
