import { useEffect, useState } from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ViewHeader } from '@/components/workspace/ViewHeader'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS } from '@/kubecode/icons/workspaceIcons'
import type { AppLocale, Translator } from '@/lib/i18n'

import type {
  Channel,
  ChannelMessage,
  ChannelThread,
  Conversation,
  KubecodeApi,
  ProjectContextRef,
  ResearchRound,
  ResearchSummary,
  WorkspaceEvent,
} from '../api'
import { ApiError } from '../api'
import type { MemberDirectory } from '../members/memberDirectory'
import type { ReferenceLabelSource } from '../references/referenceLabels'
import { useAction } from '../research/useAction'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'
import { MessageList } from './MessageList'
import { useMessageFeed } from './useChannel'

const NOT_LINKED = '__none__'
const WHOLE_QUESTION = '__whole__'

type ThreadPaneProps = {
  api: KubecodeApi
  channel: Channel
  connectionState: WorkspaceConnectionState
  directory: MemberDirectory
  events: WorkspaceEvent[]
  labels: ReferenceLabelSource
  locale?: AppLocale
  onClose: () => void
  onOpenReference: (reference: ProjectContextRef) => void
  onOpenWork?: (filter: { thread_id: string }) => void
  /** Continues the Thread in General: cites its first message in the General draft. */
  onReplyInGeneral: (root: ChannelMessage) => void
  onThreadChanged: () => void
  research: ResearchSummary[]
  sessions: Conversation[]
  t: Translator
  thread: ChannelThread
}

/**
 * A Thread from an earlier version, read-only (ADR 0229 §5): its messages, its
 * link to a Task and round, and the way to continue in General. Nothing is
 * written here, so nothing written here could reach no one.
 */
export function ThreadPane({
  api,
  channel,
  connectionState,
  directory,
  events,
  labels,
  locale,
  onClose,
  onOpenReference,
  onOpenWork,
  onReplyInGeneral,
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
  const root = feed.messages.find((message) => message.id === thread.root_message_id) ?? null

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

  return (
    <aside aria-label={t('kubecode.channel.legacyThread.title')} className="kubecode-channel-thread">
      <ViewHeader
        close={{ label: t('kubecode.channel.closeThread'), onClose }}
        description={linked
          ? t('kubecode.channel.linkedTo', { title: linked.title })
          : t('kubecode.channel.notLinked')}
        level={3}
        meta={<span className="text-muted-foreground [overflow-wrap:anywhere]">{thread.title}</span>}
        title={t('kubecode.channel.legacyThread.title')}
      />
      <Alert role="note"><AlertDescription>{t('kubecode.channel.legacyThread.readOnly')}</AlertDescription></Alert>
      <div className="kubecode-channel-link">
        <Select value={selected} onValueChange={setChoice}>
          <SelectTrigger aria-label={t('kubecode.channel.linkLabel')} className="max-w-full min-w-0" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={NOT_LINKED}>{t('kubecode.channel.notLinked')}</SelectItem>
              {candidates.map((item) => (
                <SelectItem key={item.id} value={item.id}>{item.title}</SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {chosenResearch && roundOptions.length > 0 && (
          <Select value={selectedRound} onValueChange={setRoundChoice}>
            <SelectTrigger aria-label={t('kubecode.channel.roundLabel')} className="max-w-full min-w-0" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={WHOLE_QUESTION}>{t('kubecode.channel.noRound')}</SelectItem>
                {roundOptions.map((round) => (
                  <SelectItem key={round.id} value={round.id}>
                    {t('kubecode.channel.roundOption', { round: round.round })}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
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
      {link.error && <Alert variant="destructive"><AlertDescription>{link.error}</AlertDescription></Alert>}
      <MessageList
        directory={directory}
        emptyLabel={t('kubecode.channel.threadEmpty')}
        feed={feed}
        label={t('kubecode.channel.thread')}
        labels={labels}
        locale={locale}
        projectId={thread.project_id}
        research={research}
        sessions={sessions}
        t={t}
        onOpenReference={onOpenReference}
      />
      <div className="flex justify-end">
        <Button disabled={!root} size="sm" variant="outline" onClick={() => root && onReplyInGeneral(root)}>
          <Icon role="command" source={WORKSPACE_COMMAND_ICONS.reply.Icon} />
          {t('kubecode.channel.legacyThread.replyInGeneral')}
        </Button>
      </div>
    </aside>
  )
}
