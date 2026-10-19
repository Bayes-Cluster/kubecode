import { Paperclip, X } from 'lucide-react'
import { useRef, useState } from 'react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Composer } from '@/components/workspace/Composer'
import { IconButton } from '@/components/workspace/IconButton'
import { extractMentions, type MentionOption } from '@/components/workspace/mentions'
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
  /**
   * Members that `@handle` reaches; the option id is the member's Session.
   * Mentioning is how a message addresses someone, and it is recorded with the
   * message; it never authorizes work by itself.
   */
  mentionOptions?: MentionOption[]
  /** Stops one named task or agent; sending stays available while it runs. */
  stop?: { target: string; onStop: () => void }
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
  stop,
  t,
  threadId = null,
  mentionOptions = [],
}: MessageComposerProps) {
  const [body, setBody] = useState('')
  const [intent, setIntent] = useState<ChannelIntent>('say')
  const [askSession, setAskSession] = useState('')
  const [references, setReferences] = useState<ProjectContextItem[]>([])
  const [picker, setPicker] = useState(false)
  // The id of the last attempt and the draft it carried: a retry of the same
  // draft replays the same message, an edited draft is a new message.
  const attempt = useRef<{ id: string; signature: string } | null>(null)
  const action = useAction(t)
  const asking = intent === 'ask'
  const ready = body.trim().length > 0 && (!asking || askSession !== '')

  const sending = useRef(false)

  const send = async () => {
    // A second call before the first renders must not clear the draft again or
    // be mistaken for a failed send.
    if (!ready || action.busy || sending.current) return
    sending.current = true
    try {
      await submit()
    } finally {
      sending.current = false
    }
  }

  const submit = async () => {
    const draft = { body, intent, askSession, references }
    const mentioned = extractMentions(draft.body, mentionOptions).map((option) => option.id)
    const signature = JSON.stringify([
      draft.body.trim(),
      draft.intent,
      draft.intent === 'ask' ? draft.askSession : '',
      draft.references.map((item) => `${item.ref.kind}:${item.ref.id}`),
      mentioned,
    ])
    const id = attempt.current?.signature === signature
      ? attempt.current.id
      : newClientMessageId()
    attempt.current = { id, signature }
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
      clientMessageId: id,
      intent: draft.intent,
      mentions: [...new Set([
        ...(draft.intent === 'ask' ? [draft.askSession] : []),
        ...mentioned,
      ])].map((session_id) => ({ session_id })),
      references: draft.references.map((item): ProjectContextRef => ({
        kind: item.ref.kind,
        id: item.ref.id,
        revision: item.ref.revision ?? null,
      })),
    }))
    if (sent) {
      attempt.current = null
    } else {
      setBody((current) => (current === '' ? draft.body : `${draft.body}\n${current}`))
      setReferences((current) => (current.length === 0 ? draft.references : current))
      setIntent(draft.intent)
      setAskSession(draft.askSession)
    }
  }

  return (
    <div className="kubecode-channel-composer">
      <Composer
        above={references.length > 0 && (
          <ul className="kubecode-channel-references">
            {references.map((item) => (
              <li key={`${item.ref.kind}:${item.ref.id}`}>
                <span className="kubecode-channel-reference">
                  {t(PROJECT_CONTEXT_KIND_LABELS[item.ref.kind])}
                  <span>{item.title}</span>
                  <IconButton
                    icon={<X aria-hidden size={12} />}
                    label={t('kubecode.channel.removeReference', { title: item.title })}
                    onClick={() => setReferences((current) => current.filter((candidate) => (
                      candidate.ref.kind !== item.ref.kind || candidate.ref.id !== item.ref.id
                    )))}
                  />
                </span>
              </li>
            ))}
          </ul>
        )}
        below={(
          <>
            {intent !== 'say' && (
              <p className="kubecode-research-muted">{t('kubecode.channel.intent.requestHint')}</p>
            )}
            {action.error && <p className="kubecode-research-error" role="alert">{action.error}</p>}
          </>
        )}
        busy={action.busy}
        busyLabel={t('kubecode.channel.sending')}
        canSend={ready}
        controls={(
          <>
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
            <IconButton
              disabled={references.length >= MAX_REFERENCES}
              icon={<Paperclip aria-hidden size={16} />}
              label={t('kubecode.channel.attach')}
              onClick={() => setPicker(true)}
            />
          </>
        )}
        label={placeholder}
        mentionLabel={t('kubecode.composer.mentions')}
        mentions={mentionOptions}
        placeholder={placeholder}
        sendLabel={t('kubecode.channel.send')}
        stop={stop && { label: t('kubecode.composer.stopTarget', { target: stop.target }), onStop: stop.onStop }}
        value={body}
        onChange={setBody}
        onSend={send}
      />
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
    </div>
  )
}
