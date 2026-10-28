import { useId } from 'react'

import './plan-rail.css'

/**
 * ADR 0257, adapting the affectUI "Agent Plan"
 * (https://www.affectui.com/components/agent-plan, Clean preview, captured
 * 2026-10-26) as the shared read-only plan rail: one hairline connects the
 * status markers, the active entry is emphasized, and entries are plain
 * rows. Reproduced: the rail, the three markers, count/progress is the
 * caller's (the summary card keeps it), the quiet rows. Deviations: no
 * editing, reordering, retry-from-step, or per-step clocks — the plan model
 * is a read model without stable step identity, so the list renders in
 * order and a plan rewrite replaces it as a whole (no per-index motion,
 * ADR 0257 §5). All labels come from the caller, localized; a status the
 * caller does not map renders as pending.
 *
 * States: pending, active, completed; `#/controls` (AgentUiMatrix)
 * demonstrates the three markers.
 */

export interface PlanRailEntry {
  content: string
  status: 'completed' | 'in_progress' | 'pending'
}

export interface PlanRailProps {
  entries: PlanRailEntry[]
  /** Accessible name of the list. Localized. */
  'aria-label': string
  /** The three status words, for the row's read-out — the markers are drawn
   * for the eye only. Localized. */
  statusLabels: Record<PlanRailEntry['status'], string>
  className?: string
}

const MARKER_LABEL: Record<PlanRailEntry['status'], string> = {
  completed: 'M12 8.4l2.2 2.2 4-4.4',
  in_progress: 'M12 7.5v4.5l3 1.8',
  pending: 'M12 7.5v.01M12 16.5v.01',
}

export function PlanRail({ entries, 'aria-label': ariaLabel, statusLabels, className }: PlanRailProps) {
  const listId = useId()
  return (
    <ol aria-label={ariaLabel} className={className ? `agx-plan ${className}` : 'agx-plan'} id={listId} role="list">
      {entries.map((entry, index) => (
        <li className="agx-plan__row" data-status={entry.status} key={`${index}-${entry.content}`} role="listitem">
          <span aria-hidden="true" className="agx-plan__marker">
            <svg viewBox="0 0 24 24">
              <path
                d={MARKER_LABEL[entry.status] ?? MARKER_LABEL.pending}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
              />
            </svg>
          </span>
          <span className="agx-plan__content" dir="auto">
            <span className="sr-only">{statusLabels[entry.status] ?? statusLabels.pending}: </span>
            {entry.content}
          </span>
        </li>
      ))}
    </ol>
  )
}
