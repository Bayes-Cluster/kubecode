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
import { useMentionOptions } from './useMentionOptions'
import { MessageList } from './MessageList'
import { authorName } from './channelLabels'
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
  /** Opens the one work board filtered to what came from a Thread. */
  onOpenWork?: (filter: { thread_id: string }) => void
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
  onOpenWork,
  projectId,
  research,
  t,
}: ChannelWorkspaceProps) {
  const { channel, retry, status } = useDefaultChannel(api, projectId)
  const mentionOptions = useMentionOptions(api, projectId, events, connectionState)
  // Showing only what is about one Task is a view of the same conversation.
  const [taskFilter, setTaskFilter] = useState<string | null>(null)
  const [replyTo, setReplyTo] = useState<ChannelMessage | null>(null)
  const feed = useMessageFeed(api, projectId, channel?.id ?? null, null, events, connectionState, taskFilter)
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
        {research.length > 0 && (
          <label className="kubecode-channel-filter">
            <span>{t('kubecode.channel.filterTask')}</span>
            <select
              className="kubecode-channel-select"
              value={taskFilter ?? ''}
              onChange={(event) => setTaskFilter(event.target.value || null)}
            >
              <option value="">{t('kubecode.channel.filterAll')}</option>
              {research.map((item) => (
                <option key={item.id} value={item.id}>{item.title}</option>
              ))}
            </select>
          </label>
        )}
        <MessageList
          emptyLabel={t('kubecode.channel.empty')}
          feed={feed}
          label={t('kubecode.channel.messages')}
          research={research}
          sessions={sessions}
          t={t}
          threadByRoot={threadByRoot}
          onFilterTask={setTaskFilter}
          onOpenReference={openReference}
          onOpenThread={openThread}
          onReply={setReplyTo}
        />
        {channel && (
          <MessageComposer
            api={api}
            mentionOptions={mentionOptions}
            placeholder={t('kubecode.channel.composerPlaceholder')}
            projectId={projectId}
            replyTo={replyTo && {
              id: replyTo.id,
              label: authorName(t, replyTo, sessions),
              onClear: () => setReplyTo(null),
            }}
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
          mentionOptions={mentionOptions}
          research={research}
          sessions={sessions}
          t={t}
          thread={thread}
          onClose={() => setThreadId(null)}
          onOpenReference={openReference}
          onOpenWork={onOpenWork}
          onThreadChanged={reloadThreads}
        />
      )}
    </section>
  )
}
