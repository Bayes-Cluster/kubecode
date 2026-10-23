import { MessageSquareText } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription } from '@/components/ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import type { Translator } from '@/lib/i18n'

import type { KubecodeApi, WorkspaceEvent } from '../api'
import { useChannelThreads, useDefaultChannel } from '../channel/useChannel'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'
import { ResearchSection } from './ResearchLayout'

/**
 * The Workspace-conversation Threads linked to this question: the way back
 * from the question to the discussion it came from.
 */
export function ResearchThreadsPanel({
  api,
  connectionState,
  events,
  onOpenThread,
  projectId,
  researchId,
  t,
}: {
  api: KubecodeApi
  connectionState: WorkspaceConnectionState
  events: WorkspaceEvent[]
  onOpenThread: (threadId: string) => void
  projectId: string
  researchId: string
  t: Translator
}) {
  const { channel } = useDefaultChannel(api, projectId)
  const { threads } = useChannelThreads(api, projectId, channel?.id ?? null, events, connectionState)
  const linked = threads.filter((thread) => thread.research_id === researchId)
  if (!channel) return null
  return (
    <ResearchSection label={t('kubecode.channel.linkedThreads')}>
      {linked.length === 0 ? (
        <Empty className="items-start p-0 text-left">
          <EmptyDescription>{t('kubecode.channel.noLinkedThreads')}</EmptyDescription>
        </Empty>
      ) : (
        <ItemGroup>
          {linked.map((thread) => (
            <Item key={thread.id} role="listitem" size="sm" variant="outline">
              <ItemMedia><MessageSquareText aria-hidden /></ItemMedia>
              <ItemContent>
                <ItemTitle className="[overflow-wrap:anywhere]">{thread.title}</ItemTitle>
                <ItemDescription>{t('kubecode.channel.replies', { count: thread.reply_count })}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button size="xs" variant="ghost" onClick={() => onOpenThread(thread.id)}>
                  {t('kubecode.channel.openThread')}
                </Button>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}
    </ResearchSection>
  )
}
