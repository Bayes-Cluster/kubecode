import { useCallback, useMemo, useState } from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_OBJECT_ICONS } from '@/kubecode/icons/workspaceIcons'

import { useInspectionRecord, useInspectorEntry, useInspectorServices } from '../app/inspector/inspectorContext'
import { InspectorPanel } from '../app/inspector/InspectorPanel'
import type { InspectorPanelProps } from '../app/inspector/inspectorPanels'
import { isRoutableRecordKind, type InspectorEntry } from '../app/location/inspector'
import { useWorkspaceNavigation } from '../app/location/WorkspaceNavigation'
import { StatusBadge } from '@/components/workspace/StatusBadge'
import { fallbackTitle, formatVersion, kindLabelKey } from '../resources/referenceKinds'
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
  const { api, events, t } = useInspectorServices()
  const navigation = useWorkspaceNavigation()
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

  // Named and versioned like every reference (ADR 0231 §5): never an id, never a raw fingerprint.
  const routable = isRoutableRecordKind(kind) || kind === 'file'
  const title = shown?.title ?? (routable ? fallbackTitle({ kind, id }, t) : t('kubecode.vocab.object.evidence'))
  const shownVersion = shown?.revision
    ? (routable ? formatVersion(kind, shown.revision, t) : undefined) ?? shown.revision.slice(0, 12)
    : undefined
  const recovery = {
    label: t('kubecode.resources.findInResources'),
    run: () => navigation.openPlace({ view: 'resources' }, { inspector: 'keep' }),
  }

  return (
    <InspectorPanel
      icon={<Icon role="navigation" source={WORKSPACE_OBJECT_ICONS.evidence.Icon} />}
      meta={(
        <>
          {routable && <StatusBadge tone="muted">{t(kindLabelKey(kind))}</StatusBadge>}
          {shownVersion && <StatusBadge tone="muted">{t('kubecode.task.evidence.shownVersion', { revision: shownVersion })}</StatusBadge>}
        </>
      )}
      title={title}
    >
      {failed && parentTask && (
        <Alert className="kubecode-evidence-cannot-accept" role="status">
          <AlertDescription>{t('kubecode.task.evidence.cannotAccept')}</AlertDescription>
        </Alert>
      )}
      <EvidenceViewer
        api={api}
        events={events}
        key={`${kind}:${id}:${revision ?? ''}`}
        projectId={projectId}
        recovery={recovery}
        t={t}
        target={target}
        onDisplayed={onDisplayed}
        onFailed={onFailed}
        onFollow={onFollow}
      />
    </InspectorPanel>
  )
}
