import { useEffect, useRef, useState } from 'react'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import type { Translator } from '@/lib/i18n'

import type {
  AgentDescriptor,
  Conversation,
  KubecodeApi,
  Member,
  MemberDefaults,
  WorkspaceEvent,
} from '../api'
import { DestinationHeader } from '../app/DestinationHeader'
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
  /** The Workspace's Sessions, for what each member is executing. */
  sessions?: readonly Conversation[]
}

/**
 * The Workspace's current members and, apart from them, the defaults new
 * members start from (#235): two tabs, so editing a default never reads as
 * editing a member, and a saved default never rewrites an existing one.
 */
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
  sessions,
  t,
}: MembersViewProps) {
  const scroller = useRef<HTMLElement>(null)
  const [tab, setTab] = useState<'current' | 'defaults'>('current')
  // The add form pre-fills from the defaults, so they load with the roster.
  useEffect(() => {
    if (defaults) return
    let live = true
    api.memberDefaults().then((loaded) => { if (live) onDefaultsLoaded(loaded) }, () => undefined)
    return () => { live = false }
  }, [api, defaults, onDefaultsLoaded])
  // The roster loads after arrival; restoring waits for the rows it needs.
  useScrollMemory(scroller, scrollKey, { ready: true })
  return (
    <section aria-label={t('kubecode.nav.members')} className="kubecode-members-view" ref={scroller}>
      <DestinationHeader description={t('kubecode.members.viewDescription')} destination="members" t={t} />
      <Tabs className="w-full max-w-(--ws-conversation-width) gap-3" value={tab} onValueChange={(value) => setTab(value as typeof tab)}>
        {/* On a phone the two tabs share the width and their labels wrap instead of scrolling out of view. */}
        <TabsList className="h-auto w-full sm:w-fit">
          <TabsTrigger className="h-auto whitespace-normal" value="current">{t('kubecode.members.tabs.current')}</TabsTrigger>
          <TabsTrigger className="h-auto whitespace-normal" value="defaults">{t('kubecode.members.tabs.defaults')}</TabsTrigger>
        </TabsList>
        <TabsContent value="current">
          <MemberRoster
            agents={agents}
            api={api}
            connectionState={connectionState}
            defaults={defaults}
            events={events}
            projectId={projectId}
            sessions={sessions}
            t={t}
            onOpenDm={onOpenDm}
            onOpenMember={onOpenMember}
          />
        </TabsContent>
        <TabsContent value="defaults">
          <MemberDefaultsPanel agents={agents} api={api} t={t} onLoaded={onDefaultsLoaded} />
        </TabsContent>
      </Tabs>
    </section>
  )
}
