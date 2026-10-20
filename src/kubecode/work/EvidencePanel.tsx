import { useMemo } from 'react'

import { Icon } from '@/kubecode/icons'
import { WORKSPACE_OBJECT_ICONS } from '@/kubecode/icons/workspaceIcons'

import { useInspectionRecord, useInspectorServices } from '../app/inspector/inspectorContext'
import { InspectorPanel } from '../app/inspector/InspectorPanel'
import type { InspectorPanelProps } from '../app/inspector/inspectorPanels'
import type { InspectorEntry } from '../app/location/inspector'
import { EvidenceViewer, type EvidenceTarget } from './EvidenceViewer'

/**
 * Evidence in the inspector: a record as a Task cited it, at its pinned
 * revision, over the Task it came from. It tells the stack which version it
 * actually displayed, only once that version is on screen, so a review can
 * accept only what the researcher saw. #218 owns this adapter.
 */
export function EvidencePanel({ entry, projectId }: InspectorPanelProps<Extract<InspectorEntry, { kind: 'evidence' }>>) {
  const { api, t } = useInspectorServices()
  const { markDisplayed } = useInspectionRecord()
  const { id, kind, revision = null } = entry.ref
  // One object per record: the viewer reads again whenever its target changes.
  const target = useMemo<EvidenceTarget>(() => ({ kind, id, revision }), [id, kind, revision])
  return (
    <InspectorPanel icon={<Icon role="navigation" source={WORKSPACE_OBJECT_ICONS.evidence.Icon} />} title={`${kind}:${id}`}>
      <EvidenceViewer
        api={api}
        key={`${kind}:${id}:${revision ?? ''}`}
        projectId={projectId}
        t={t}
        target={target}
        onDisplayed={(shown) => markDisplayed({ kind: shown.kind, id: shown.id }, shown.revision)}
      />
    </InspectorPanel>
  )
}
