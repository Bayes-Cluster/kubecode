import { AiAgentIcon } from '@/components/AiAgentIcon'
import { StatusBadge } from '@/components/workspace/StatusBadge'

import { useInspectorServices } from '../app/inspector/inspectorContext'
import { InspectorPanel } from '../app/inspector/InspectorPanel'
import type { InspectorPanelProps } from '../app/inspector/inspectorPanels'
import type { InspectorEntry } from '../app/location/inspector'
import { useWorkspaceNavigation } from '../app/location/WorkspaceNavigation'
import { STATE_LABELS } from './memberModel'
import { MemberProfile } from './MemberProfile'

/**
 * A member's profile in the inspector, read from the live roster by id. A
 * member no longer on it is unavailable, with Back and Close kept. #217 owns
 * this adapter.
 */
export function MemberPanel({ entry }: InspectorPanelProps<Extract<InspectorEntry, { kind: 'member' }>>) {
  const { roster, t } = useInspectorServices()
  const navigation = useWorkspaceNavigation()
  const member = roster.find((item) => item.id === entry.id)
  if (!member) return <InspectorPanel status="unavailable" title={t('kubecode.inspector.memberDetail')} />
  return (
    <InspectorPanel
      icon={<AiAgentIcon agent={member.spec.agent_id} size={18} />}
      meta={(
        <StatusBadge tone={member.state === 'active' ? 'ok' : 'warn'}>
          {t(STATE_LABELS[member.state])}
        </StatusBadge>
      )}
      title={member.name}
    >
      <MemberProfile member={member} t={t} onOpenDm={(chosen) => navigation.openPlace({ view: 'dm', member: chosen.id })} />
    </InspectorPanel>
  )
}
