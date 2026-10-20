import { useMemo } from 'react'

import { Icon } from '@/kubecode/icons'
import { WORKSPACE_DESTINATION_ICONS } from '@/kubecode/icons/workspaceIcons'

import { useInspectorServices } from '../app/inspector/inspectorContext'
import { InspectorPanel } from '../app/inspector/InspectorPanel'
import type { InspectorPanelProps } from '../app/inspector/inspectorPanels'
import type { InspectorEntry } from '../app/location/inspector'
import { EvidenceViewer, type EvidenceTarget } from '../work/EvidenceViewer'

/**
 * A Project record in the inspector, read live: no revision is pinned or
 * claimed. #219 owns this adapter and replaces it with its resource preview.
 */
export function ResourcePanel({ entry, projectId }: InspectorPanelProps<Extract<InspectorEntry, { kind: 'resource' }>>) {
  const { api, t } = useInspectorServices()
  const { id, kind } = entry.ref
  const target = useMemo<EvidenceTarget>(() => ({ kind, id, revision: null }), [id, kind])
  return (
    <InspectorPanel icon={<Icon role="navigation" source={WORKSPACE_DESTINATION_ICONS.resources.Icon} />} title={`${kind}:${id}`}>
      <EvidenceViewer api={api} key={`${kind}:${id}`} projectId={projectId} t={t} target={target} />
    </InspectorPanel>
  )
}
