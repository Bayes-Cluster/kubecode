import { Paperclip, X } from 'lucide-react'
import { useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import type { Translator } from '@/lib/i18n'

import type {
  ChannelIntent,
  Conversation,
  KubecodeApi,
  NewChannelMessage,
  ProjectContextItem,
  ProjectContextRef,
} from '../api'
import { ComposerProjectWorkPicker } from '../ComposerProjectWorkPicker'
import { PROJECT_CONTEXT_KIND_LABELS } from '../projectContext'
import { newClientMessageId } from '../session/sessionModel'
import { useAction } from '../research/useAction'

const MAX_REFERENCES = 16

export type MessageComposerProps = {
  api: KubecodeApi
  placeholder: string
  projectId: string
  /** Sessions that can be asked (not Team members or subagents). */
  sessions: Conversation[]
  t: Translator
  threadId?: string | null
  /** Saves the message; resolves once it is stored. */
  onSend: (message: NewChannelMessage) => Promise<void>
}

/**
 * Writes one message. The client message id is kept until the send succeeds, so
 * a retry after a lost response replays the same message instead of adding a
 * second one. Choosing "ask" or "request" only records the intent.
 */
export function MessageComposer({
  api,
  onSend,
  placeholder,
  projectId,
  sessions,
  t,
  threadId = null,
}: MessageComposerProps) {
  const [body, setBody] = useState('')
  const [intent, setIntent] = useState<ChannelIntent>('say')
  const [askSession, setAskSession] = useState('')
  const [references, setReferences] = useState<ProjectContextItem[]>([])
  const [picker, setPicker] = useState(false)
  const clientId = useRef(newClientMessageId())
  const action = useAction(t)
  const asking = intent === 'ask'
  const ready = body.trim().length > 0 && (!asking || askSession !== '')

  const send = async () => {
    if (!ready || action.busy) return
    const draft = { body, intent, askSession, references }
    // Clear at once so what the researcher types next is never lost to the
    // completion of this send; put the draft back if it fails and nothing new
    // has been typed. The client id stays until the send succeeds, so a retry
    // replays the same message.
    setBody('')
    setReferences([])
    setIntent('say')
    setAskSession('')
    const sent = await action.run(() => onSend({
      body: draft.body.trim(),
      threadId,
      clientMessageId: clientId.current,
      intent: draft.intent,
      mentions: draft.intent === 'ask' ? [{ session_id: draft.askSession }] : [],
      references: draft.references.map((item): ProjectContextRef => ({
        kind: item.ref.kind,
        id: item.ref.id,
        revision: item.ref.revision ?? null,
      })),
    }))
    if (sent) {
      clientId.current = newClientMessageId()
    } else {
      setBody((current) => (current === '' ? draft.body : current))
      setReferences((current) => (current.length === 0 ? draft.references : current))
      setIntent(draft.intent)
      setAskSession(draft.askSession)
    }
  }

  return (
    <form
      className="kubecode-channel-composer"
      onSubmit={(event) => {
        event.preventDefault()
        void send()
      }}
    >
      <Textarea
        aria-label={placeholder}
        placeholder={placeholder}
        rows={3}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void send()
          }
        }}
      />
      {references.length > 0 && (
        <ul className="kubecode-channel-references">
          {references.map((item) => (
            <li key={`${item.ref.kind}:${item.ref.id}`}>
              <span className="kubecode-channel-reference">
                {t(PROJECT_CONTEXT_KIND_LABELS[item.ref.kind])}
                <span>{item.title}</span>
                <button
                  aria-label={t('kubecode.channel.removeReference', { title: item.title })}
                  type="button"
                  onClick={() => setReferences((current) => current.filter((candidate) => (
                    candidate.ref.kind !== item.ref.kind || candidate.ref.id !== item.ref.id
                  )))}
                >
                  <X aria-hidden size={12} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="kubecode-channel-composer-row">
        <select
          aria-label={t('kubecode.channel.intent.label')}
          className="kubecode-channel-select"
          value={intent}
          onChange={(event) => setIntent(event.target.value as ChannelIntent)}
        >
          <option value="say">{t('kubecode.channel.intent.say')}</option>
          <option value="ask">{t('kubecode.channel.intent.ask')}</option>
          <option value="request">{t('kubecode.channel.intent.request')}</option>
        </select>
        {asking && (
          <select
            aria-label={t('kubecode.channel.askSession')}
            className="kubecode-channel-select"
            value={askSession}
            onChange={(event) => setAskSession(event.target.value)}
          >
            <option value="">{t('kubecode.channel.chooseSession')}</option>
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>{session.title}</option>
            ))}
          </select>
        )}
        <Button
          aria-label={t('kubecode.channel.attach')}
          disabled={references.length >= MAX_REFERENCES}
          size="icon-xs"
          type="button"
          variant="ghost"
          onClick={() => setPicker(true)}
        >
          <Paperclip aria-hidden size={16} />
        </Button>
        <Button
          disabled={!ready || action.busy}
          size="sm"
          type="submit"
        >
          {action.busy ? t('kubecode.channel.sending') : t('kubecode.channel.send')}
        </Button>
      </div>
      {intent === 'request' && (
        <p className="kubecode-research-muted">{t('kubecode.channel.intent.requestHint')}</p>
      )}
      {action.error && <p className="kubecode-research-error" role="alert">{action.error}</p>}
      <Dialog open={picker} onOpenChange={setPicker}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('kubecode.channel.attach')}</DialogTitle>
            <DialogDescription>{t('kubecode.channel.attachHint')}</DialogDescription>
          </DialogHeader>
          <ComposerProjectWorkPicker
            api={api}
            conversationId=""
            projectId={projectId}
            t={t}
            onSelect={(item) => {
              setReferences((current) => (
                current.some((candidate) => candidate.ref.kind === item.ref.kind && candidate.ref.id === item.ref.id)
                  ? current
                  : [...current, item]
              ))
              setPicker(false)
            }}
          />
        </DialogContent>
      </Dialog>
    </form>
  )
}
