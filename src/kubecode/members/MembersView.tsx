import type { Translator } from '@/lib/i18n'

import type {
  AgentDescriptor,
  KubecodeApi,
  Member,
  MemberDefaults,
  WorkspaceEvent,
} from '../api'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'
import { MemberDefaultsPanel } from './MemberDefaultsPanel'
import { MemberRoster } from './MemberRoster'

export type MembersViewProps = {
  agents: AgentDescriptor[]
  api: KubecodeApi
  connectionState: WorkspaceConnectionState
  defaults: MemberDefaults | null
  events: WorkspaceEvent[]
  projectId: string
  t: Translator
  onDefaultsLoaded: (defaults: MemberDefaults) => void
  onOpenDm: (member: Member) => void
  onOpenMember: (member: Member) => void
}

/** The roster of agents and the defaults new Workspaces start from. */
export function MembersView({
  agents,
  api,
  connectionState,
  defaults,
  events,
  onDefaultsLoaded,
  onOpenDm,
  onOpenMember,
  projectId,
  t,
}: MembersViewProps) {
  return (
    <section aria-label={t('kubecode.nav.members')} className="kubecode-members-view">
      <header className="kubecode-channel-header">
        <div>
          <h2>{t('kubecode.nav.members')}</h2>
        </div>
      </header>
      <MemberRoster
        agents={agents}
        api={api}
        connectionState={connectionState}
        defaults={defaults}
        events={events}
        projectId={projectId}
        t={t}
        onOpenDm={onOpenDm}
        onOpenMember={onOpenMember}
      />
      <MemberDefaultsPanel agents={agents} api={api} t={t} onLoaded={onDefaultsLoaded} />
    </section>
  )
}
