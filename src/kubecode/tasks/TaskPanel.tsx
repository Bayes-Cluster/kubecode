import { useInspectorEntry, useInspectorServices } from '../app/inspector/inspectorContext'
import type { InspectorPanelProps } from '../app/inspector/inspectorPanels'
import { isRoutableRecordKind, type InspectorEntry, type InspectorRecordKind } from '../app/location/inspector'
import { useWorkspaceNavigation } from '../app/location/WorkspaceNavigation'
import { ResearchWorkspace } from '../research/ResearchWorkspace'
import type { EvidenceTarget } from '../work/EvidenceViewer'
import { TaskInspector } from './TaskInspector'

function recordKindOf(kind: string): InspectorRecordKind | null {
  return kind === 'file' || isRoutableRecordKind(kind) ? kind : null
}

/**
 * A Task in the inspector: its research record (brief, work, findings) with
 * the Task inspector on top, as the detail pane showed it before ADR 0228.
 * The record's own header carries the inspector's Back and Close, so there is
 * still one header; review evidence opens over the Task, which stays mounted
 * below it. #218 replaces this adapter with the Task panel.
 */
export function TaskPanel({ entry, projectId }: InspectorPanelProps<Extract<InspectorEntry, { kind: 'task' }>>) {
  const services = useInspectorServices()
  const inspector = useInspectorEntry()
  const navigation = useWorkspaceNavigation()
  const inspectEvidence = (target: EvidenceTarget) => {
    const kind = recordKindOf(target.kind)
    if (!kind) return
    inspector.push(
      { kind: 'evidence', ref: { kind, id: target.id, revision: target.revision ?? null } },
      { from: `evidence:${target.kind}:${target.id}` },
    )
  }
  return (
    <ResearchWorkspace
      agents={services.agents}
      api={services.api}
      back={inspector.header.back}
      close={inspector.header.close}
      connectionState={services.connectionState}
      conversations={services.sessionCatalog}
      events={services.events}
      projectId={projectId}
      researchId={entry.id}
      startsRounds={false}
      t={services.t}
      teams={services.teams}
      inspector={(
        <TaskInspector
          api={services.api}
          connectionState={services.connectionState}
          events={services.events}
          projectId={projectId}
          t={services.t}
          taskId={entry.id}
          onInspectEvidence={inspectEvidence}
          onShowMessage={(messageId) => navigation.openPlace({ view: 'general', message: messageId, thread: null })}
        />
      )}
      onConversationCreated={services.onConversationCreated}
      onOpenBoard={(filter) => navigation.openPlace({ view: 'board' }, { inspect: { kind: 'task', id: filter.research_id } })}
      onOpenSession={(conversationId) => navigation.openSession(conversationId)}
      onOpenThread={(threadId) => navigation.openPlace({ view: 'general', thread: threadId })}
      onTitle={inspector.setTitle}
    />
  )
}
