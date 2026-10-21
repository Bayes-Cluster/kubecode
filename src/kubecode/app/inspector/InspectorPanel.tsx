import { useEffect, type ReactNode } from 'react'

import { ViewHeader } from '@/components/workspace/ViewHeader'

import { useInspectorEntry, useInspectorServices } from './inspectorContext'

export type InspectorPanelStatus = 'ready' | 'loading' | 'unavailable'

export type InspectorPanelProps = {
  /** The entry's title; it also names this entry in the next level's "Back to …". */
  title: string
  icon?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  /** `unavailable`: the record is gone; Back and Close stay. */
  status?: InspectorPanelStatus
  /** Where to look instead, offered beside the `unavailable` notice. */
  recovery?: ReactNode
  children?: ReactNode
}

/**
 * The frame of every inspector panel: exactly one ViewHeader (level 3) with
 * the Back and Close the pane computed, then the body. A panel never renders
 * an aside, a Back, or a Close of its own (ADR 0227, ADR 0228).
 */
export function InspectorPanel({ actions, children, icon, meta, recovery, status = 'ready', title }: InspectorPanelProps) {
  const { header, setTitle } = useInspectorEntry()
  const { t } = useInspectorServices()

  useEffect(() => { setTitle(title) }, [setTitle, title])

  return (
    <div className="kubecode-inspector-panel" data-status={status}>
      <ViewHeader
        {...header}
        actions={status === 'ready' ? actions : undefined}
        icon={icon}
        meta={status === 'ready' ? meta : undefined}
        title={title}
      />
      <div className="kubecode-inspector-body">
        {status === 'ready' && children}
        {status === 'loading' && <p className="kubecode-research-muted" role="status">{t('kubecode.loading')}</p>}
        {status === 'unavailable' && (
          <p className="kubecode-research-notice" role="status">
            {t('kubecode.inspector.unavailable')}{recovery && ' '}{recovery}
          </p>
        )}
      </div>
    </div>
  )
}
