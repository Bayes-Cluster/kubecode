import { useCallback, useMemo, useState } from 'react'

import { StatusBadge } from '@/components/workspace/StatusBadge'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_OBJECT_ICONS } from '@/kubecode/icons/workspaceIcons'

import { useInspectionRecord, useInspectorEntry, useInspectorServices } from '../app/inspector/inspectorContext'
import { InspectorPanel } from '../app/inspector/InspectorPanel'
import type { InspectorPanelProps } from '../app/inspector/inspectorPanels'
import { isRoutableRecordKind, type InspectorEntry } from '../app/location/inspector'
import { EvidenceViewer, type DisplayedEvidence, type EvidenceTarget } from './EvidenceViewer'

/**
 * Evidence in the inspector: a record as a Task cited it, at its pinned
 * revision, over the Task it came from (ADR 0230 §4). It tells the stack which
 * version it actually displayed, only once that version is on screen, so a
 * review can accept only what the researcher saw; a read that failed leaves
 * no record and, under a Task, says it cannot be accepted. A related record
 * opens over it, so what was cited stays the one displayed.
 */
export function EvidencePanel({ entry, parentTask, projectId }: InspectorPanelProps<Extract<InspectorEntry, { kind: 'evidence' }>>) {
  const { api, t } = useInspectorServices()
  const { push } = useInspectorEntry()
  const { markDisplayed } = useInspectionRecord()
  const { id, kind, revision = null } = entry.ref
  // One object per record: the viewer reads again whenever its target changes.
  const target = useMemo<EvidenceTarget>(() => ({ kind, id, revision }), [id, kind, revision])
  const [shown, setShown] = useState<DisplayedEvidence | null>(null)
  const [failed, setFailed] = useState(false)

  const onDisplayed = useCallback((displayed: DisplayedEvidence) => {
    setShown(displayed)
    setFailed(false)
    markDisplayed({ kind: displayed.kind, id: displayed.id }, displayed.revision)
  }, [markDisplayed])
  const onFailed = useCallback(() => setFailed(true), [])
  const onFollow = useCallback((ref: { kind: string; id: string }) => {
    if (!isRoutableRecordKind(ref.kind)) return
    push({ kind: 'resource', ref: { kind: ref.kind, id: ref.id } }, { from: `related:${ref.kind}:${ref.id}` })
  }, [push])

  return (
    <InspectorPanel
      icon={<Icon role="navigation" source={WORKSPACE_OBJECT_ICONS.evidence.Icon} />}
      meta={shown?.revision ? (
        <StatusBadge tone="muted">{t('kubecode.task.evidence.shownVersion', { revision: shown.revision.slice(0, 12) })}</StatusBadge>
      ) : undefined}
      title={shown?.title ?? `${kind}:${id}`}
    >
      {failed && parentTask && (
        <p className="kubecode-research-notice" role="status">{t('kubecode.task.evidence.cannotAccept')}</p>
      )}
      <EvidenceViewer
        api={api}
        key={`${kind}:${id}:${revision ?? ''}`}
        projectId={projectId}
        t={t}
        target={target}
        onDisplayed={onDisplayed}
        onFailed={onFailed}
        onFollow={onFollow}
      />
    </InspectorPanel>
  )
}
