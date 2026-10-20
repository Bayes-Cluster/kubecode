import { useRef } from 'react'

import type { Translator } from '@/lib/i18n'

import type {
  AgentDescriptor,
  KubecodeApi,
  Member,
  MemberDefaults,
  WorkspaceEvent,
} from '../api'
import { useScrollMemory } from '../app/location/placeMemory'
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
  /** Where the view's scroll position is kept for the place (`placeKey.view`). */
  scrollKey?: string | null
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
  scrollKey = null,
  t,
}: MembersViewProps) {
  const scroller = useRef<HTMLElement>(null)
  // The roster loads after arrival; restoring waits for the rows it needs.
  useScrollMemory(scroller, scrollKey, { ready: true })
  return (
    <section aria-label={t('kubecode.nav.members')} className="kubecode-members-view" ref={scroller}>
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
