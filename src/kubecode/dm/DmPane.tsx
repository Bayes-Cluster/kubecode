import { useContext, useEffect, useRef, useState } from 'react'

import { Message, MessageContent, MessageResponse, PromptInput, PromptInputBody, PromptInputFooter, Shimmer } from '@/components/ai-elements'
import { MarkdownContent } from '@/components/MarkdownContent'
import { Button } from '@/components/ui/button'
import { Composer } from '@/components/workspace/Composer'
import { StatusBadge } from '@/components/workspace/StatusBadge'
import { ViewHeader } from '@/components/workspace/ViewHeader'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS, WORKSPACE_DESTINATION_ICONS } from '@/kubecode/icons/workspaceIcons'
import type { Translator } from '@/lib/i18n'

import type { ChannelMessage, KubecodeApi, Member, ResearchSummary, WorkspaceEvent } from '../api'
import { ApiError } from '../api'
import { errorMessage } from '../app/errors'
import { placeKey, usePlaceState } from '../app/location/placeMemory'
import { WorkspaceNavigationContext } from '../app/location/WorkspaceNavigation'
import { ExecutionStrip } from '../attention/ExecutionStrip'
import type { PlainDraft } from '../channel/generalDraft'
import { useOutbox, type OutboxItem } from '../channel/outbox'
import { OutboxRows } from '../channel/OutboxRows'
import { Identity } from '../members/Identity'
import { memberView, researcherView } from '../members/memberIdentity'
import { newClientMessageId } from '../session/sessionModel'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'
import { DmShareDialog } from './DmShareDialog'
import { useDmPending } from './useDmPending'
import { useDmTurns } from './useDmTurns'

export type DmPaneProps = {
  api: KubecodeApi
  connectionState: WorkspaceConnectionState
  events: WorkspaceEvent[]
  member: Member
  projectId: string
  research: ResearchSummary[]
  t: Translator
  /** Called after part of the conversation was shared to General. */
  onShared?: (message: ChannelMessage) => void
}

const EMPTY_DRAFT: PlainDraft = { body: '', attempt: null }

type DmSend = { text: string }

/**
 * The researcher's private conversation with one member (ADR 0223, ADR 0229).
 * It looks and types like General — the same identity, Markdown, and draft
 * mechanics — but is held in the member's own DM Session: other members
 * cannot read, search, mention, or cite it. Sharing into General is a
 * separate, previewed act.
 */
export function DmPane({
  api,
  connectionState,
  events,
  member,
  onShared,
  projectId,
  research,
  t,
}: DmPaneProps) {
  const navigation = useContext(WorkspaceNavigationContext)
  const { reload, status, turns } = useDmTurns(
    api,
    projectId,
    member.id,
    member.dm_conversation_id,
    events,
    connectionState,
  )
  // What waits behind the member's running reply, read from the server (ADR 0232).
  const queue = useDmPending(api, projectId, member.id, member.dm_conversation_id, events, connectionState)
  // The unsent private draft and its last attempt outlive the pane for the life of the page, never on disk.
  const [draft, setDraft] = usePlaceState<PlainDraft>(`${placeKey.dm(projectId, member.id)}#draft`, EMPTY_DRAFT)
  // Sends the server has not acknowledged, each its own row (ADR 0232 §5).
  const outbox = useOutbox<DmSend>(`${placeKey.dm(projectId, member.id)}#outbox`)
  const lastSent = useRef<PlainDraft | null>(null)
  const [sharing, setSharing] = useState(false)
  const [shared, setShared] = useState<ChannelMessage | null>(null)
  const log = useRef<HTMLDivElement>(null)
  const you = researcherView(t)
  const them = memberView(member, t)
  const ready = member.state === 'active'

  // New turns, and the member's reply after a send, come into view.
  const newest = turns.at(-1)
  const newestAssistant = newest?.assistant
  useEffect(() => {
    const element = log.current
    if (element) element.scrollTop = element.scrollHeight
  }, [turns.length, newestAssistant])

  const failureOf = (cause: unknown): string => {
    if (cause instanceof ApiError && cause.code === 'dm_busy') return t('kubecode.dm.busyKept', { name: member.name })
    if (cause instanceof ApiError && cause.code === 'dm_failed') return t('kubecode.dm.failed')
    // A dropped connection rejects fetch with the browser's own, untranslated words.
    if (cause instanceof TypeError) return t('kubecode.error')
    return errorMessage(cause, t('kubecode.error'))
  }

  /** Sends one outbox row under its own client id; Send again replays that id. */
  const deliver = (item: Pick<OutboxItem<DmSend>, 'id' | 'text' | 'payload'>) => outbox.send(
    item,
    async () => {
      await api.sendMemberDm(projectId, member.id, item.payload.text, item.id)
      setShared(null)
      reload()
      queue.reload()
    },
    failureOf,
  )

  // Returns at once: the send goes on as its outbox row, so a second message
  // can follow it, and what is typed next is never merged into a failed one.
  const send = () => {
    const text = draft.body.trim()
    if (!text || !ready || lastSent.current === draft) return
    lastSent.current = draft
    setDraft((current) => ({ ...current, body: '', attempt: null }))
    void deliver({ id: newClientMessageId(), text, payload: { text } })
  }

  return (
    <section aria-label={t('kubecode.dm.title', { name: member.name })} className="kubecode-channel-workspace">
      <div className="kubecode-channel-main">
        <ViewHeader
          actions={(
            <Button disabled={turns.length === 0} size="xs" variant="outline" onClick={() => setSharing(true)}>
              <Icon role="command" source={WORKSPACE_COMMAND_ICONS.share.Icon} />
              {t('kubecode.dm.share')}
            </Button>
          )}
          className="kubecode-channel-header"
          icon={<Icon role="navigation" source={WORKSPACE_DESTINATION_ICONS.directMessage.Icon} />}
          meta={(
            <>
              <Identity view={them} />
              <StatusBadge tone="info">{t('kubecode.dm.privateBadge')}</StatusBadge>
            </>
          )}
          title={t('kubecode.dm.title', { name: member.name })}
        />
        {shared && (
          <p className="kubecode-research-muted" role="status">
            {t('kubecode.dm.shared')}{' '}
            {navigation && (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => navigation.openPlace({ view: 'general', message: shared.id }, { focus: `message:${shared.id}` })}
              >
                {t('kubecode.dm.showInGeneral')}
              </Button>
            )}
          </p>
        )}
        <div aria-label={t('kubecode.channel.messages')} className="kubecode-channel-messages" ref={log} role="log">
          {status === 'loading' && (
            <p className="kubecode-research-muted" role="status">{t('kubecode.channel.loading')}</p>
          )}
          {status === 'error' && (
            <p className="kubecode-research-error" role="alert">
              {t('kubecode.dm.loadFailed')}{' '}
              <Button size="xs" variant="ghost" onClick={reload}>{t('kubecode.retry')}</Button>
            </p>
          )}
          {status === 'ready' && turns.length === 0 && (
            <p className="kubecode-research-muted">{t('kubecode.dm.empty')}</p>
          )}
          {turns.map((turn) => (
            <div className="kubecode-dm-turn" data-testid={`dm-turn-${turn.run_id}`} key={turn.run_id}>
              <Message aria-label={you.name} author={<span className="sr-only">{you.name}</span>} from="self">
                <MessageContent>
                  <MessageResponse className="kubecode-message-body"><MarkdownContent content={turn.user} images="text" /></MessageResponse>
                </MessageContent>
              </Message>
              {turn.assistant && (
                <Message aria-label={them.name} author={<Identity size="sm" view={them} />} from="member">
                  <MessageContent>
                    <MessageResponse className="kubecode-message-body"><MarkdownContent content={turn.assistant} images="text" /></MessageResponse>
                  </MessageContent>
                </Message>
              )}
            </div>
          ))}
          {newest && !newest.assistant && (
            <Message aria-label={them.name} author={<Identity size="sm" view={them} />} from="member" state="pending">
              <MessageContent>
                <p className="kubecode-dm-waiting" role="status">
                  <Shimmer>{t('kubecode.dm.waitingReply', { name: member.name })}</Shimmer>
                </p>
              </MessageContent>
            </Message>
          )}
          {queue.pending.map((item) => (
            <Message aria-label={you.name} author={<span className="sr-only">{you.name}</span>} from="self" key={item.client_message_id} state="pending">
              <MessageContent>
                <MessageResponse className="kubecode-message-body"><MarkdownContent content={item.text} images="text" /></MessageResponse>
                <p className="kubecode-message-delivery" data-delivery="queued">{t('kubecode.dm.queued', { name: member.name })}</p>
              </MessageContent>
            </Message>
          ))}
        </div>
        {/* What is under way, what did not go, and the input card, together at the foot (#232). */}
        <div className="kubecode-conversation-dock">
          <ExecutionStrip api={api} scope={{ binding: 'dm', memberId: member.id }} t={t} />
          <OutboxRows
            items={outbox.items}
            t={t}
            onDiscard={(item) => outbox.discard(item.id)}
            onEdit={draft.body.trim() === '' ? (item) => {
              outbox.discard(item.id)
              setDraft((current) => ({ ...current, body: item.payload.text }))
            } : undefined}
            onSendAgain={(item) => void deliver(item)}
          />
          <PromptInput>
            <PromptInputBody>
              <Composer
                disabled={!ready}
                focusKey={`composer:dm:${member.id}`}
                label={t('kubecode.dm.placeholder', { name: member.name })}
                placeholder={t('kubecode.dm.placeholder', { name: member.name })}
                sendLabel={t('kubecode.channel.send')}
                value={draft.body}
                onChange={(body) => setDraft((current) => ({ ...current, body }))}
                onSend={send}
              />
            </PromptInputBody>
            <PromptInputFooter className="kubecode-composer-footer">
              {ready
                ? <p className="kubecode-composer-hint">{t('kubecode.dm.destination', { name: member.name })}</p>
                : (
                  <p className="kubecode-composer-warning" role="status">
                    {t('kubecode.dm.needsSetup', { name: member.name })}{' '}
                    {navigation && (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => navigation.openPlace({ view: 'members' }, { inspect: { kind: 'member', id: member.id } })}
                      >
                        {t('kubecode.dm.fixInMembers')}
                      </Button>
                    )}
                  </p>
                )}
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
      <DmShareDialog
        api={api}
        member={member}
        open={sharing}
        projectId={projectId}
        research={research}
        t={t}
        turns={turns}
        onOpenChange={setSharing}
        onShared={(message) => {
          setShared(message)
          onShared?.(message)
        }}
      />
    </section>
  )
}
