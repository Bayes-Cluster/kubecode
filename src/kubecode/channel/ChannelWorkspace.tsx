import { useCallback, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import type { Translator } from '@/lib/i18n'

import type {
  ChannelMessage,
  Conversation,
  KubecodeApi,
  NewChannelMessage,
  ProjectContextRef,
  ResearchSummary,
  WorkspaceEvent,
} from '../api'
import { useAction } from '../research/useAction'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'
import { MessageComposer } from './MessageComposer'
import { MessageList } from './MessageList'
import { ThreadPane } from './ThreadPane'
import { useChannelThreads, useDefaultChannel, useMessageFeed } from './useChannel'

export type ChannelWorkspaceProps = {
  api: KubecodeApi
  connectionState: WorkspaceConnectionState
  /** Sessions of every Project; filtered to this one here. */
  conversations: Conversation[]
  events: WorkspaceEvent[]
  /** A Thread to open on arrival (for example from a research question). */
  initialThreadId?: string | null
  onClose: () => void
  onOpenResearch: (researchId: string) => void
  onOpenSession: (conversationId: string) => void
  projectId: string
  research: ResearchSummary[]
  t: Translator
}

/**
 * The Workspace's shared conversation: the default channel as a timeline of
 * topics, with a Thread pane beside it. Execution authority lives elsewhere;
 * nothing here starts an Agent.
 */
export function ChannelWorkspace({
  api,
  connectionState,
  conversations,
  events,
  initialThreadId = null,
  onClose,
  onOpenResearch,
  onOpenSession,
  projectId,
  research,
  t,
}: ChannelWorkspaceProps) {
  const { channel, retry, status } = useDefaultChannel(api, projectId)
  const feed = useMessageFeed(api, projectId, channel?.id ?? null, null, events, connectionState)
  const { reload: reloadThreads, threads } = useChannelThreads(
    api,
    projectId,
    channel?.id ?? null,
    events,
    connectionState,
  )
  const [threadId, setThreadId] = useState<string | null>(initialThreadId)
  const startThread = useAction(t)
  const sessions = useMemo(() => conversations.filter((item) => (
    item.project_id === projectId
    && !item.archived
    && !item.team_id
    && item.relationship !== 'team_member'
    && item.relationship !== 'subagent'
  )), [conversations, projectId])
  const threadByRoot = useMemo(
    () => new Map(threads.map((thread) => [thread.root_message_id, thread])),
    [threads],
  )
  const thread = threads.find((item) => item.id === threadId) ?? null

  const send = useCallback(async (message: NewChannelMessage) => {
    if (!channel) return
    const saved = await api.postChannelMessage(projectId, channel.id, message)
    feed.append(saved)
  }, [api, channel, feed, projectId])

  const openThread = (message: ChannelMessage) => {
    const existing = threadByRoot.get(message.id)
    if (existing) {
      setThreadId(existing.id)
      return
    }
    if (!channel) return
    void startThread.run(async () => {
      const started = await api.startChannelThread(projectId, channel.id, message.id)
      reloadThreads()
      setThreadId(started.id)
    })
  }

  const openReference = (reference: ProjectContextRef) => {
    if (reference.kind === 'research') onOpenResearch(reference.id)
    else if (reference.kind === 'session') onOpenSession(reference.id)
    else if (reference.kind === 'thread') setThreadId(reference.id)
  }

  return (
    <section aria-label={t('kubecode.channel.title')} className="kubecode-channel-workspace">
      <div className="kubecode-channel-main">
        <header className="kubecode-channel-header">
          <div>
            <Button size="xs" variant="ghost" onClick={onClose}>{t('kubecode.channel.back')}</Button>
            <h2>{channel?.is_default ? `# ${t('kubecode.channel.general')}` : channel?.name ?? t('kubecode.channel.title')}</h2>
            <p className="kubecode-research-muted">{t('kubecode.channel.subtitle')}</p>
          </div>
        </header>
        {status === 'error' && (
          <p className="kubecode-research-error" role="alert">
            {t('kubecode.channel.loadFailed')}{' '}
            <Button size="xs" variant="ghost" onClick={retry}>{t('kubecode.retry')}</Button>
          </p>
        )}
        {startThread.error && <p className="kubecode-research-error" role="alert">{startThread.error}</p>}
        <MessageList
          emptyLabel={t('kubecode.channel.empty')}
          feed={feed}
          label={t('kubecode.channel.messages')}
          sessions={sessions}
          t={t}
          threadByRoot={threadByRoot}
          onOpenReference={openReference}
          onOpenThread={openThread}
        />
        {channel && (
          <MessageComposer
            api={api}
            placeholder={t('kubecode.channel.composerPlaceholder')}
            projectId={projectId}
            sessions={sessions}
            t={t}
            onSend={send}
          />
        )}
      </div>
      {channel && thread && (
        <ThreadPane
          api={api}
          channel={channel}
          connectionState={connectionState}
          events={events}
          key={thread.id}
          research={research}
          sessions={sessions}
          t={t}
          thread={thread}
          onClose={() => setThreadId(null)}
          onOpenReference={openReference}
          onThreadChanged={reloadThreads}
        />
      )}
    </section>
  )
}
