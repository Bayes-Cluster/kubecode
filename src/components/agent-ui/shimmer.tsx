import type { CSSProperties } from 'react'

import './shimmer.css'

/**
 * ADR 0257, recreating the affectUI "Shimmer Loader" motion
 * (https://www.affectui.com/motion/shimmer-loader, Clean preview, captured
 * 2026-10-26): skeleton blocks and text with one shared highlight sweep.
 * Reproduced: the viewport-fixed gradient so every block on screen sweeps in
 * sync, the circle/radius variants, the clipped-gradient text shimmer, the
 * static reduced-motion state. Deviations: block and glow colours come from
 * the Kubecode tokens; the demo's card fixture is not part of the component.
 *
 * Skeleton blocks are decorative (aria-hidden); pair them with an accessible
 * busy state where the wait is meaningful. ShimmerText renders real text.
 * States: `#/controls` (AgentUiMatrix).
 */

export interface ShimmerBlockProps {
  width?: number | string
  height?: number | string
  radius?: number | string
  circle?: boolean
  className?: string
  style?: CSSProperties
}

const length = (value: number | string | undefined): string | undefined =>
  typeof value === 'number' ? `${value}px` : value

export function ShimmerBlock({ width, height, radius, circle, className, style }: ShimmerBlockProps) {
  return (
    <span
      aria-hidden="true"
      className={className ? `agx-shimmer ${className}` : 'agx-shimmer'}
      style={{
        width: length(width),
        height: circle ? length(width) ?? length(height) : length(height),
        borderRadius: circle ? '50%' : length(radius),
        ...style,
      }}
    />
  )
}

export interface ShimmerTextProps {
  children: string
  /** One sweep in seconds. */
  duration?: number
  className?: string
}

export function ShimmerText({ children, duration = 2, className }: ShimmerTextProps) {
  const style = duration === 2 ? undefined : ({ '--agx-shimmer-text-dur': `${duration}s` } as CSSProperties)
  return (
    <span className={className ? `agx-shimmer-text ${className}` : 'agx-shimmer-text'} style={style}>
      {children}
    </span>
  )
}
