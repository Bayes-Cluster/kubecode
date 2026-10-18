import { MessageSquareText } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { Translator } from '@/lib/i18n'

import type { KubecodeApi, WorkspaceEvent } from '../api'
import { useChannelThreads, useDefaultChannel } from '../channel/useChannel'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'

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
    <section className="kubecode-research-section">
      <h3>{t('kubecode.channel.linkedThreads')}</h3>
      {linked.length === 0 && (
        <p className="kubecode-research-muted">{t('kubecode.channel.noLinkedThreads')}</p>
      )}
      <ul className="kubecode-research-list">
        {linked.map((thread) => (
          <li key={thread.id}>
            <MessageSquareText aria-hidden size={14} />
            <span>{thread.title}</span>
            <span className="kubecode-research-muted">
              {t('kubecode.channel.replies', { count: thread.reply_count })}
            </span>
            <Button size="xs" variant="ghost" onClick={() => onOpenThread(thread.id)}>
              {t('kubecode.channel.openThread')}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}
