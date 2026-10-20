import type { ReactNode } from 'react'

import type { InspectorPresentation } from './useInspectorPresentation'

/**
 * A Workspace view with its inspector beside it, or over it (ADR 0228 §3).
 * Over it, the view stays mounted and is parked, inert, with
 * `visibility: hidden` by the `[data-inspector-layout='screen']` rules, so
 * its scroll position and inputs survive; it is never removed with
 * `display: none`.
 */
export function WithInspector({
  children,
  inspector,
  presentation,
}: {
  children: ReactNode
  /** The InspectorPane, or nothing while the inspector is closed. */
  inspector: ReactNode
  presentation: InspectorPresentation
}) {
  const open = inspector !== null && inspector !== undefined && inspector !== false
  const covered = open && presentation === 'screen'
  return (
    <div className="kubecode-with-detail" data-detail={open} data-inspector-layout={presentation}>
      <div className="kubecode-inspector-main" inert={covered ? true : undefined}>{children}</div>
      {inspector}
    </div>
  )
}
