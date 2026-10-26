import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { usePrefersReducedMotion } from '@/lib/reducedMotion'

import './blur-swap.css'

/**
 * ADR 0257, recreating the affectUI "Blur Crossfade"
 * (https://www.affectui.com/motion/blur-crossfade, Clean preview, captured
 * 2026-10-26): when `swapKey` changes, the outgoing content blurs and scales
 * out while the incoming content blurs in, and the container's height (and,
 * with `morph="both"`, its width) glides between the two sizes. Reproduced:
 * the keyed two-layer swap, the bounded height morph, the resting-size
 * tracking, the instant reduced-motion swap. Deviations: the container is a
 * plain `div` (the reference's `as` polymorphism is not kept); colours and
 * easing come from the tokens; the demo's rotating release-note fixture is
 * not part of the component — content changes only when the caller's state
 * changes.
 *
 * States: demonstrated in `#/controls` (AgentUiMatrix, swapping and settled).
 */

export interface BlurSwapProps {
  /** Change this to swap the content. Everything else is presentation. */
  swapKey: string | number
  morph?: 'height' | 'both' | 'none'
  duration?: number
  blur?: number
  className?: string
  style?: React.CSSProperties
  children: React.ReactNode
}

interface Outgoing {
  node: React.ReactNode
  width: number
  height: number
  run: number
}

export function BlurSwap({
  swapKey,
  morph = 'height',
  duration = 420,
  blur = 10,
  className,
  style,
  children,
}: BlurSwapProps) {
  const reduced = usePrefersReducedMotion()
  const container = useRef<HTMLDivElement | null>(null)
  const layer = useRef<HTMLDivElement | null>(null)
  const [outgoing, setOutgoing] = useState<Outgoing | null>(null)
  const previousKey = useRef<unknown>(swapKey)
  const previousChildren = useRef<React.ReactNode>(children)
  const resting = useRef({ width: 0, height: 0 })
  const busy = useRef(false)
  const settle = useRef(0)
  const runs = useRef(0)

  useLayoutEffect(() => {
    const element = container.current
    const next = layer.current
    if (swapKey === previousKey.current || !element || !next) {
      previousChildren.current = children
      return
    }
    previousKey.current = swapKey
    const incoming = previousChildren.current
    previousChildren.current = children
    window.clearTimeout(settle.current)

    const size = { width: next.offsetWidth, height: next.offsetHeight }
    if (reduced || duration <= 0) {
      // No outgoing layer is rendered while motion is reduced; a stale one
      // from an earlier animated swap is cleared by its own settle timer.
      element.style.height = ''
      element.style.width = ''
      element.style.transition = ''
      element.removeAttribute('data-busy')
      busy.current = false
      resting.current = size
      return
    }

    const current = busy.current
      ? { width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }
      : resting.current
    setOutgoing({ node: incoming, width: resting.current.width, height: resting.current.height, run: ++runs.current })
    resting.current = size
    busy.current = true
    element.setAttribute('data-busy', '')

    if (morph !== 'none') {
      element.style.transition = 'none'
      element.style.height = `${current.height}px`
      if (morph === 'both') element.style.width = `${current.width}px`
      void element.offsetHeight
      const easing = `${duration}ms var(--agx-ease)`
      element.style.transition = morph === 'both' ? `height ${easing}, width ${easing}` : `height ${easing}`
      element.style.height = `${size.height}px`
      if (morph === 'both') element.style.width = `${size.width}px`
    }
    settle.current = window.setTimeout(() => {
      element.style.height = ''
      element.style.width = ''
      element.style.transition = ''
      element.removeAttribute('data-busy')
      busy.current = false
      setOutgoing(null)
    }, duration + 30)
  }, [swapKey, children, morph, duration, reduced])

  useEffect(() => {
    const element = layer.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (!busy.current) resting.current = { width: element.offsetWidth, height: element.offsetHeight }
    })
    observer.observe(element)
    resting.current = { width: element.offsetWidth, height: element.offsetHeight }
    return () => observer.disconnect()
  }, [swapKey])

  useEffect(() => () => window.clearTimeout(settle.current), [])

  return (
    <div
      ref={container}
      data-morph={morph}
      className={className ? `agx-blur ${className}` : 'agx-blur'}
      style={{
        '--agx-blur-duration': `${duration}ms`,
        '--agx-blur-amount': `${blur}px`,
        ...style,
      } as React.CSSProperties}
    >
      <div key={`in-${swapKey}`} ref={layer} className="agx-blur__layer agx-blur__layer--in">
        {children}
      </div>
      {outgoing && !reduced && (
        <div
          key={`out-${outgoing.run}`}
          className="agx-blur__layer agx-blur__layer--out"
          aria-hidden="true"
          inert={true}
          style={morph === 'both' ? { width: outgoing.width || undefined } : undefined}
        >
          {outgoing.node}
        </div>
      )}
    </div>
  )
}
