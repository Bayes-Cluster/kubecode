import { X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import type { Translator } from '@/lib/i18n'

import type {
  Channel,
  ChannelThread,
  Conversation,
  KubecodeApi,
  NewChannelMessage,
  ProjectContextRef,
  ResearchRound,
  ResearchSummary,
  WorkspaceEvent,
} from '../api'
import { ApiError } from '../api'
import { useAction } from '../research/useAction'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'
import { MessageComposer } from './MessageComposer'
import { MessageList } from './MessageList'
import { useMessageFeed } from './useChannel'

const NOT_LINKED = '__none__'
const WHOLE_QUESTION = ''

type ThreadPaneProps = {
  api: KubecodeApi
  channel: Channel
  connectionState: WorkspaceConnectionState
  events: WorkspaceEvent[]
  onClose: () => void
  onOpenReference: (reference: ProjectContextRef) => void
  onOpenWork?: (filter: { thread_id: string }) => void
  onThreadChanged: () => void
  research: ResearchSummary[]
  sessions: Conversation[]
  t: Translator
  thread: ChannelThread
}

/**
 * One Thread: its messages, a reply box, and the link to a research question.
 * Linking never moves a message; it records the link in the Thread itself.
 */
export function ThreadPane({
  api,
  channel,
  connectionState,
  events,
  onClose,
  onOpenReference,
  onOpenWork,
  onThreadChanged,
  research,
  sessions,
  t,
  thread,
}: ThreadPaneProps) {
  const feed = useMessageFeed(
    api,
    thread.project_id,
    channel.id,
    thread.id,
    events,
    connectionState,
  )
  const [choice, setChoice] = useState<string | null>(null)
  const [roundChoice, setRoundChoice] = useState<string | null>(null)
  const [rounds, setRounds] = useState<{ researchId: string; rounds: ResearchRound[] } | null>(null)
  const link = useAction(t)
  const selected = choice ?? thread.research_id ?? NOT_LINKED
  const linked = research.find((item) => item.id === thread.research_id)
  const chosenResearch = selected === NOT_LINKED ? null : selected
  const selectedRound = roundChoice ?? (
    chosenResearch === thread.research_id ? thread.round_id ?? WHOLE_QUESTION : WHOLE_QUESTION
  )
  const roundOptions = rounds && rounds.researchId === chosenResearch ? rounds.rounds : []
  const candidates = research.filter((item) => !item.archived || item.id === thread.research_id)

  useEffect(() => {
    if (!chosenResearch || typeof api.listResearchRounds !== 'function') return
    let cancelled = false
    api.listResearchRounds(thread.project_id, chosenResearch)
      .then((loaded) => { if (!cancelled) setRounds({ researchId: chosenResearch, rounds: loaded }) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [api, thread.project_id, chosenResearch])

  const apply = async () => {
    const researchId = selected === NOT_LINKED ? null : selected
    const done = await link.run(async () => {
      try {
        await api.linkChannelThread(
          thread.project_id,
          thread.id,
          thread.revision,
          researchId,
          researchId && selectedRound !== WHOLE_QUESTION ? selectedRound : null,
        )
      } catch (cause) {
        if (cause instanceof ApiError && cause.code === 'thread_revision_conflict') {
          onThreadChanged()
          feed.reload()
          throw new Error(t('kubecode.channel.error.threadChanged'))
        }
        throw cause
      }
    })
    if (done) {
      setChoice(null)
      setRoundChoice(null)
      onThreadChanged()
      feed.reload()
    }
  }

  const reply = async (message: NewChannelMessage) => {
    const saved = await api.postChannelMessage(thread.project_id, channel.id, {
      ...message,
      threadId: thread.id,
    })
    feed.append(saved)
    onThreadChanged()
  }

  return (
    <aside aria-label={t('kubecode.channel.thread')} className="kubecode-channel-thread">
      <header>
        <div>
          <h3>{thread.title}</h3>
          <p className="kubecode-research-muted">
            {linked
              ? t('kubecode.channel.linkedTo', { title: linked.title })
              : t('kubecode.channel.notLinked')}
          </p>
        </div>
        <Button
          aria-label={t('kubecode.channel.closeThread')}
          size="icon-xs"
          variant="ghost"
          onClick={onClose}
        >
          <X aria-hidden size={16} />
        </Button>
      </header>
      <div className="kubecode-channel-link">
        <select
          aria-label={t('kubecode.channel.linkLabel')}
          className="kubecode-channel-select"
          value={selected}
          onChange={(event) => setChoice(event.target.value)}
        >
          <option value={NOT_LINKED}>{t('kubecode.channel.notLinked')}</option>
          {candidates.map((item) => (
            <option key={item.id} value={item.id}>{item.title}</option>
          ))}
        </select>
        {chosenResearch && roundOptions.length > 0 && (
          <select
            aria-label={t('kubecode.channel.roundLabel')}
            className="kubecode-channel-select"
            value={selectedRound}
            onChange={(event) => setRoundChoice(event.target.value)}
          >
            <option value={WHOLE_QUESTION}>{t('kubecode.channel.noRound')}</option>
            {roundOptions.map((round) => (
              <option key={round.id} value={round.id}>
                {t('kubecode.channel.roundOption', { round: round.round })}
              </option>
            ))}
          </select>
        )}
        <Button
          disabled={link.busy || (
            selected === (thread.research_id ?? NOT_LINKED)
            && (chosenResearch === null || selectedRound === (thread.round_id ?? WHOLE_QUESTION))
          )}
          size="sm"
          variant="outline"
          onClick={() => void apply()}
        >
          {selected === NOT_LINKED ? t('kubecode.channel.unlink') : t('kubecode.channel.link')}
        </Button>
        {linked && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onOpenReference({ kind: 'research', id: linked.id })}
          >
            {t('kubecode.channel.openResearch')}
          </Button>
        )}
        {onOpenWork && (
          <Button size="sm" variant="ghost" onClick={() => onOpenWork({ thread_id: thread.id })}>
            {t('kubecode.channel.openWork')}
          </Button>
        )}
      </div>
      {link.error && <p className="kubecode-research-error" role="alert">{link.error}</p>}
      <MessageList
        emptyLabel={t('kubecode.channel.threadEmpty')}
        feed={feed}
        label={t('kubecode.channel.thread')}
        sessions={sessions}
        t={t}
        onOpenReference={onOpenReference}
      />
      <MessageComposer
        api={api}
        key={thread.id}
        placeholder={t('kubecode.channel.threadPlaceholder')}
        projectId={thread.project_id}
        sessions={sessions}
        t={t}
        threadId={thread.id}
        onSend={reply}
      />
    </aside>
  )
}
