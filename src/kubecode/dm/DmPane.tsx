import { Share2 } from 'lucide-react'
import { useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Composer } from '@/components/workspace/Composer'
import type { Translator } from '@/lib/i18n'

import type { KubecodeApi, Member, ResearchSummary, WorkspaceEvent } from '../api'
import { ApiError } from '../api'
import { errorMessage } from '../app/errors'
import { newClientMessageId } from '../session/sessionModel'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'
import { DmShareDialog } from './DmShareDialog'
import { useDmTurns } from './useDmTurns'

export type DmPaneProps = {
  api: KubecodeApi
  connectionState: WorkspaceConnectionState
  events: WorkspaceEvent[]
  member: Member
  projectId: string
  research: ResearchSummary[]
  t: Translator
  onClose: () => void
  /** Called after part of the conversation was shared to General. */
  onShared?: () => void
}

/**
 * The researcher's private conversation with one member. It looks and types
 * like General (the shared Composer) but is held in the member's own DM
 * Session: other members cannot read, search, mention, or cite it. Sharing
 * into General is a separate, previewed act.
 */
export function DmPane({
  api,
  connectionState,
  events,
  member,
  onClose,
  onShared,
  projectId,
  research,
  t,
}: DmPaneProps) {
  const { reload, status, turns } = useDmTurns(
    api,
    projectId,
    member.id,
    member.dm_conversation_id,
    events,
    connectionState,
  )
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sharing, setSharing] = useState(false)
  const [shared, setShared] = useState(false)
  // One id per typed message, kept until it is delivered, so a retry after a
  // lost reply is the same message.
  const attempt = useRef<{ id: string; text: string } | null>(null)

  const send = async () => {
    const text = draft.trim()
    if (!text || busy) return
    const id = attempt.current?.text === text ? attempt.current.id : newClientMessageId()
    attempt.current = { id, text }
    setBusy(true)
    setError(null)
    try {
      await api.sendMemberDm(projectId, member.id, text, id)
      attempt.current = null
      setDraft('')
      setShared(false)
      reload()
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'dm_busy') {
        setError(t('kubecode.dm.busy', { name: member.name }))
      } else if (cause instanceof ApiError && cause.code === 'dm_failed') {
        setError(t('kubecode.dm.failed'))
      } else {
        setError(errorMessage(cause, t('kubecode.error')))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label={t('kubecode.dm.title', { name: member.name })} className="kubecode-channel-workspace">
      <div className="kubecode-channel-main">
        <header className="kubecode-channel-header">
          <div>
            <Button size="xs" variant="ghost" onClick={onClose}>{t('kubecode.dm.back')}</Button>
            <h2>{t('kubecode.dm.title', { name: member.name })}</h2>
            <p className="kubecode-research-muted">{t('kubecode.dm.private', { name: member.name })}</p>
          </div>
          <Button
            disabled={turns.length === 0}
            size="xs"
            variant="outline"
            onClick={() => setSharing(true)}
          >
            <Share2 aria-hidden size={14} />
            {t('kubecode.dm.share')}
          </Button>
        </header>
        {shared && <p className="kubecode-research-muted" role="status">{t('kubecode.dm.shared')}</p>}
        <div aria-label={t('kubecode.channel.messages')} className="kubecode-channel-messages" role="log">
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
            <article className="kubecode-channel-message" data-testid={`dm-turn-${turn.run_id}`} key={turn.run_id}>
              <header><strong>{t('kubecode.channel.author.researcher')}</strong></header>
              <p className="kubecode-channel-body">{turn.user}</p>
              {turn.assistant && (
                <>
                  <header><strong>{member.name}</strong></header>
                  <p className="kubecode-channel-body">{turn.assistant}</p>
                </>
              )}
            </article>
          ))}
        </div>
        <Composer
          below={error && <p className="kubecode-research-error" role="alert">{error}</p>}
          busy={busy}
          busyLabel={t('kubecode.dm.sending')}
          label={t('kubecode.dm.placeholder', { name: member.name })}
          placeholder={t('kubecode.dm.placeholder', { name: member.name })}
          sendLabel={t('kubecode.channel.send')}
          value={draft}
          onChange={setDraft}
          onSend={send}
        />
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
        onShared={() => {
          setShared(true)
          onShared?.()
        }}
      />
    </section>
  )
}
