/**
 * The panel registry (ADR 0228 §3): what renders each kind of inspector entry.
 * The shell composes it; each feature slice owns its adapter file and replaces
 * it while keeping the export name (tasks/TaskPanel, members/MemberPanel,
 * work/EvidencePanel, resources/ResourcePanel).
 */

import type { ComponentType } from 'react'

import { MemberPanel } from '../../members/MemberPanel'
import { ResourcePanel } from '../../resources/ResourcePanel'
import { TaskPanel } from '../../tasks/TaskPanel'
import { EvidencePanel } from '../../work/EvidencePanel'
import type { InspectorEntry, InspectorKind } from '../location/inspector'

export type InspectorPanelProps<E extends InspectorEntry = InspectorEntry> = {
  entry: E
  projectId: string
  /** The Task this entry was opened from: the nearest task entry below it. */
  parentTask: string | null
  /** Whether the entry is the top of the stack. */
  active: boolean
}

export type InspectorPanels = {
  [K in InspectorKind]: ComponentType<InspectorPanelProps<Extract<InspectorEntry, { kind: K }>>>
}

export const INSPECTOR_PANELS: InspectorPanels = {
  task: TaskPanel,
  member: MemberPanel,
  evidence: EvidencePanel,
  resource: ResourcePanel,
}
