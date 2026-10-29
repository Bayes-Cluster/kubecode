import type { HTMLAttributes, ReactNode } from 'react'

import './change-summary.css'

/**
 * ADR 0257, adapting the affectUI "Change Summary"
 * (https://www.affectui.com/components/change-summary, Clean preview,
 * captured 2026-10-29): one compact summary row — a tinted square, the
 * label, the count — for a group of real changes. The tallies are the
 * adapter's own; absent ones stay absent, and nothing here reverts,
 * stages or diffs. The Git panel's change groups (#285) present their
 * heads through this row.
 *
 * States: `#/controls` (AgentUiMatrix) shows the row in its tones.
 */

export function AgxChangeSummaryRow({
  tone,
  icon,
  label,
  count,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  tone?: 'bad' | 'good' | 'info'
  /** The tone's glyph, drawn inside the tinted square. */
  icon?: ReactNode
  label: ReactNode
  /** The group's real tally, said for everyone. */
  count: ReactNode
}) {
  return (
    <div
      {...props}
      className={className ? `agx-csum__row ${className}` : 'agx-csum__row'}
      data-tone={tone}
    >
      {icon !== undefined && icon !== null && (
        <span aria-hidden="true" className="agx-csum__mark">
          {icon}
        </span>
      )}
      <span className="agx-csum__label">{label}</span>
      <span className="agx-csum__count">{count}</span>
    </div>
  )
}
