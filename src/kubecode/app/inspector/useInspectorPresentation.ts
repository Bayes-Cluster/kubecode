import { useEffect, useState, type RefObject } from 'react'

/** Beside the view (`side`) or replacing it (`screen`, as on a phone). */
export type InspectorPresentation = 'side' | 'screen'

/** The narrowest a Workspace view stays readable beside an inspector. */
export const VIEW_MIN = 480
/** The inspector's column: the shell's `--ws-panel-inspector` (ADR 0234). */
export const INSPECTOR_MIN = 360

/**
 * Whether the inspector fits beside the view (ADR 0228 §3, ADR 0234). It measures the
 * row the view and the inspector share, less what the open Files and Git
 * column takes (`reservedWidth`), so a mid-size screen with tools open gets a
 * full-screen inspector rather than three cramped columns. Where the row
 * cannot be measured (no ResizeObserver, or before its first report), the
 * narrow layout decides.
 */
export function useInspectorPresentation(
  rowRef: RefObject<HTMLElement | null>,
  { narrowLayout, reservedWidth }: { reservedWidth: number; narrowLayout: boolean },
): InspectorPresentation {
  const [width, setWidth] = useState<number | null>(null)

  useEffect(() => {
    const row = rowRef.current
    if (!row || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.observe(row)
    return () => observer.disconnect()
  }, [rowRef])

  if (width === null) return narrowLayout ? 'screen' : 'side'
  return width - reservedWidth >= VIEW_MIN + INSPECTOR_MIN ? 'side' : 'screen'
}
