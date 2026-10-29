import { useId } from 'react'

import './progress-ring.css'

/**
 * ADR 0257, adapting the affectUI "Project Card" progress ring
 * (https://www.affectui.com/components/project-card, Clean preview,
 * captured 2026-10-29): one segment per unit of the caller's real count,
 * done ones in the accent, the tally in the middle. Past twelve units the
 * segments become one proportional arc — slivers say nothing. The ring
 * presents; where the count comes from and what a done unit means belong to
 * the adapter (#283: a Task's work rollup).
 *
 * States: `#/controls` (AgentUiMatrix) shows the ring with the board and
 * filter specimens.
 */

export function AgxProgressRing({
  done,
  total,
  label,
}: {
  /** The finished units, from the adapter's own data. */
  done: number
  /** The units altogether. */
  total: number
  /** What the ring says to assistive tech ("3 of 5 work items done"). */
  label: string
}) {
  const id = useId()
  if (total <= 0) return null
  const clampedDone = Math.max(0, Math.min(done, total))
  const segmented = total > 0 && total <= 12
  const count = segmented ? total : 24
  const radius = 13
  const circumference = 2 * Math.PI * radius
  // The ring runs from the top; round caps paint past the dash, so the gap
  // clears the stroke width and single-unit rings stay readable.
  const gap = segmented && total > 1 ? 5 : 0
  const span = circumference / count - gap
  return (
    <span className="agx-ring">
      <svg aria-hidden="true" className="agx-ring__svg" viewBox="0 0 32 32">
        <g transform="rotate(-90 16 16)">
          {Array.from({ length: count }, (_, index) => {
            const at = index * (circumference / count)
            const isDone = segmented ? index < clampedDone : index < Math.round((clampedDone / total) * count)
            return (
              <circle
                data-done={isDone || undefined}
                key={`${id}-${index}`}
                pathLength={circumference}
                r={radius}
                strokeDasharray={`${Math.max(span, 1)} ${circumference}`}
                strokeDashoffset={-at - gap / 2}
                cx="16"
                cy="16"
                className="agx-ring__seg"
              />
            )
          })}
        </g>
      </svg>
      <span aria-label={label} className="agx-ring__num" role="img">
        {segmented ? `${clampedDone}/${total}` : `${Math.round((clampedDone / total) * 100)}%`}
      </span>
    </span>
  )
}
