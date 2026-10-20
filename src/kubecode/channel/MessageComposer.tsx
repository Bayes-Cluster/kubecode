import { useId, useRef, useState, type Dispatch, type Ref, type SetStateAction } from 'react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Composer } from '@/components/workspace/Composer'
import { IconButton } from '@/components/workspace/IconButton'
import { RecipientRow, type Recipient } from '@/components/workspace/RecipientRow'
import { ReferenceChip } from '@/components/workspace/ReferenceChip'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS } from '@/kubecode/icons/workspaceIcons'
import type { Translator } from '@/lib/i18n'

import { ApiError, type ChannelMessage, type KubecodeApi, type NewChannelMessage, type ProjectContextItem } from '../api'
import { errorMessage } from '../app/errors'
import { ComposerProjectWorkPicker } from '../ComposerProjectWorkPicker'
import { Identity } from '../members/Identity'
import { canReceive, type MemberDirectory } from '../members/memberDirectory'
import { memberView } from '../members/memberIdentity'
import type { ReferenceLabelSource } from '../references/referenceLabels'
import { newClientMessageId } from '../session/sessionModel'
import {
  draftRecipients,
  removeMention,
  sendBlockedReason,
  toNewMessage,
  type GeneralDraft,
} from './generalDraft'
import { mentionOptions } from './mentionOptions'
import { useOutbox, type OutboxItem } from './outbox'
import { OutboxRows } from './OutboxRows'

/** What a General send carries: the message, and the draft it came from for Edit. */
type GeneralSend = {
  message: Omit<NewChannelMessage, 'clientMessageId'>
  draft: Pick<GeneralDraft, 'body' | 'reply' | 'task' | 'references'>
}

const MAX_REFERENCES = 16

/** Hands the text box to the ref the parent gave, whichever kind it is. */
function assignRef<T>(ref: Ref<T> | undefined, value: T) {
  if (typeof ref === 'function') ref(value)
  else if (ref) (ref as { current: T }).current = value
}

export type MessageComposerProps = {
  api: KubecodeApi
  projectId: string
  t: Translator
  placeholder: string
  directory: MemberDirectory
  labels: ReferenceLabelSource
  /** The draft of this place (ADR 0229 §6); the setter keeps writing after the composer is gone. */
  draft: GeneralDraft
  onDraftChange: Dispatch<SetStateAction<GeneralDraft>>
  /** Names the text box for focus return (`data-focus-key`). */
  focusKey: string
  textareaRef?: Ref<HTMLTextAreaElement>
  /** Where this place's unsent messages are kept (`<place>#outbox`); null keeps them with the composer. */
  outboxKey: string | null
  /** Saves the message; resolves with it once it is stored. */
  onSend: (message: NewChannelMessage) => Promise<ChannelMessage>
  onSent?: (message: ChannelMessage) => void
  /** Stops one named turn (its label says whose); sending stays available while it runs. */
  stop?: { label: string; shortLabel?: string; onStop: () => void }
}

/**
 * Writes one General message (ADR 0229 §4–§6): the text, whom it goes to (the
 * members it @mentions, or the project manager), the Task it is about and its
 * references, and the message it replies to. There are no message types.
 * Each send is its own outbox row until the server has it (ADR 0232 §5): a
 * failed one stays there with Send again (the same message), Edit and
 * Discard, apart from whatever is typed next.
 */
export function MessageComposer({
  api,
  directory,
  draft,
  focusKey,
  labels,
  onDraftChange,
  onSend,
  onSent,
  outboxKey,
  placeholder,
  projectId,
  stop,
  t,
  textareaRef,
}: MessageComposerProps) {
  const hintId = useId()
  const area = useRef<HTMLTextAreaElement | null>(null)
  const [picker, setPicker] = useState(false)
  const outbox = useOutbox<GeneralSend>(outboxKey)
  const lastSent = useRef<GeneralDraft | null>(null)
  const recipients = draftRecipients(draft.body, directory)
  const blocked = sendBlockedReason(recipients, t)
  const ready = draft.body.trim().length > 0 && blocked === null
  const update = (patch: Partial<GeneralDraft>) => onDraftChange((current) => ({ ...current, ...patch }))
  const focusText = () => area.current?.focus()
  const setArea = (node: HTMLTextAreaElement | null) => {
    area.current = node
    assignRef(textareaRef, node)
  }

  const failureOf = (cause: unknown): string => {
    if (cause instanceof ApiError && cause.code === 'mention_unavailable') {
      const named = cause.memberId ? directory.byId.get(cause.memberId) : undefined
      directory.reload()
      return named
        ? t('kubecode.channel.mentionUnavailable', { name: named.name })
        : t('kubecode.channel.mentionUnavailableUnknown')
    }
    return errorMessage(cause, t('kubecode.error'))
  }

  /** Sends one outbox row under its own client id; a repeat replays that id. */
  const deliver = (item: Pick<OutboxItem<GeneralSend>, 'id' | 'text' | 'payload'>) => outbox.send(
    item,
    async () => {
      const saved = await onSend({ ...item.payload.message, clientMessageId: item.id })
      onSent?.(saved)
    },
    failureOf,
  )

  // Returns at once: the send goes on as its outbox row, so the composer is
  // never held while it is on its way and another message can follow it.
  const send = () => {
    // A second call for the same draft before it is cleared is the same send.
    if (!ready || lastSent.current === draft) return
    lastSent.current = draft
    const { message } = toNewMessage(draft, recipients)
    const item = {
      id: newClientMessageId(),
      text: draft.body,
      payload: { message, draft: { body: draft.body, reply: draft.reply, task: draft.task, references: draft.references } },
    }
    // The draft clears at once and is never filled again by this send: if it
    // fails it stays as its own row, so what is typed meanwhile is never merged
    // into it, and sending it again is the same message.
    onDraftChange((current) => ({ ...current, body: '', reply: null, references: [], attempt: null, failure: null }))
    void deliver(item)
  }

  /** Puts a failed send back into the empty composer, as a new message from then on. */
  const edit = (item: OutboxItem<GeneralSend>) => {
    outbox.discard(item.id)
    onDraftChange((current) => ({
      ...current,
      body: item.payload.draft.body,
      reply: item.payload.draft.reply,
      task: item.payload.draft.task,
      references: item.payload.draft.references,
    }))
    focusText()
  }

  const insertMention = () => {
    const box = area.current
    const caret = box?.selectionStart ?? draft.body.length
    const before = draft.body.slice(0, caret)
    const spaced = before === '' || /\s$/.test(before) ? '@' : ' @'
    const body = `${before}${spaced}${draft.body.slice(caret)}`
    update({ body })
    const next = caret + spaced.length
    requestAnimationFrame(() => {
      box?.focus()
      box?.setSelectionRange(next, next)
    })
    box?.focus()
  }

  const pick = (item: ProjectContextItem) => {
    setPicker(false)
    if (item.ref.kind === 'research') {
      update({ task: item.ref.id, taskCleared: false })
      return
    }
    onDraftChange((current) => (
      current.references.some((existing) => existing.ref.kind === item.ref.kind && existing.ref.id === item.ref.id)
        || current.references.length >= MAX_REFERENCES
        ? current
        : { ...current, references: [...current.references, item] }
    ))
  }

  const removeReference = (item: ProjectContextItem) => onDraftChange((current) => ({
    ...current,
    references: current.references.filter((existing) => existing.ref.kind !== item.ref.kind || existing.ref.id !== item.ref.id),
  }))

  const toRecipients: Recipient[] = recipients.kind === 'members'
    ? [...recipients.reachable, ...recipients.unreachable.map((entry) => entry.member)].map((member) => {
      const view = memberView(member, t)
      return {
        ...view,
        removeLabel: t('kubecode.channel.removeRecipient', { name: member.name }),
        onRemove: () => onDraftChange((current) => ({ ...current, body: removeMention(current.body, member.handle) })),
      }
    })
    : []
  const manager = recipients.kind === 'manager' ? recipients.manager : null
  const nobody = recipients.kind === 'unknown'
    ? recipients.status === 'loading'
      ? <span className="kubecode-composer-hint">{t('kubecode.members.loading')}</span>
      : (
        <span className="kubecode-composer-warning">
          {t('kubecode.members.loadFailed')}{' '}
          <Button size="xs" variant="ghost" onClick={() => directory.reload()}>{t('kubecode.members.retryLoad')}</Button>
        </span>
      )
    : manager && canReceive(manager)
      ? <Identity size="sm" view={memberView(manager, t)} />
      : <span className="kubecode-composer-warning">{t('kubecode.channel.noRecipient')}</span>
  const taskLabel = draft.task ? labels({ kind: 'research', id: draft.task }) : null

  return (
    <div className="kubecode-channel-composer">
      <OutboxRows
        items={outbox.items}
        t={t}
        onDiscard={(item) => outbox.discard(item.id)}
        onEdit={draft.body.trim() === '' ? edit : undefined}
        onSendAgain={(item) => void deliver(item)}
      />
      <Composer
        above={(
          <>
            {draft.reply && (
              <p className="kubecode-channel-replying">
                <span>{t('kubecode.channel.replyingToExcerpt', { author: draft.reply.authorName, excerpt: draft.reply.excerpt })}</span>
                <IconButton
                  icon={<Icon role="command" size="secondary" source={WORKSPACE_COMMAND_ICONS.close.Icon} />}
                  label={t('kubecode.channel.clearReply')}
                  onClick={() => {
                    update({ reply: null })
                    focusText()
                  }}
                />
              </p>
            )}
            {(taskLabel || draft.references.length > 0) && (
              <div className="kubecode-composer-about">
                <span className="kubecode-composer-about-label">{t('kubecode.channel.about')}</span>
                <ul aria-label={t('kubecode.channel.references')}>
                  {taskLabel && (
                    <li>
                      <ReferenceChip
                        kind="task"
                        kindLabel={taskLabel.kindLabel}
                        removeLabel={t('kubecode.channel.removeTask', { title: taskLabel.title })}
                        title={taskLabel.title}
                        onRemove={() => {
                          update({ task: null, taskCleared: true })
                          focusText()
                        }}
                      />
                    </li>
                  )}
                  {draft.references.map((item) => {
                    const label = labels(item.ref)
                    const title = item.title || label.title
                    return (
                      <li key={`${item.ref.kind}:${item.ref.id}`}>
                        <ReferenceChip
                          kind={label.kind}
                          kindLabel={label.kindLabel}
                          removeLabel={t('kubecode.channel.removeReference', { title })}
                          title={title}
                          onRemove={() => {
                            removeReference(item)
                            focusText()
                          }}
                        />
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}
          </>
        )}
        below={(
          <>
            <RecipientRow
              empty={nobody}
              label={t('kubecode.channel.to')}
              recipients={toRecipients}
              onFocusAfterLast={focusText}
            />
            {blocked && draft.body.trim() !== '' && <p className="kubecode-composer-warning" role="status">{blocked}</p>}
            <p className="kubecode-composer-hint" id={hintId}>{t('kubecode.channel.authorizationHint')}</p>
          </>
        )}
        canSend={ready}
        controls={(
          <>
            <IconButton
              disabled={draft.references.length >= MAX_REFERENCES}
              icon={<Icon role="command" source={WORKSPACE_COMMAND_ICONS.addContext.Icon} />}
              label={t('kubecode.vocab.command.addContext')}
              onClick={() => setPicker(true)}
            />
            <IconButton
              icon={<Icon role="command" source={WORKSPACE_COMMAND_ICONS.mention.Icon} />}
              label={t('kubecode.vocab.command.mention')}
              onClick={insertMention}
            />
          </>
        )}
        describedBy={hintId}
        focusKey={focusKey}
        label={placeholder}
        mentionLabel={t('kubecode.composer.mentions')}
        mentions={mentionOptions(directory, t)}
        placeholder={placeholder}
        sendDisabledReason={blocked ?? undefined}
        sendLabel={t('kubecode.channel.send')}
        stop={stop}
        textareaRef={setArea}
        value={draft.body}
        // Emptied by hand: the draft is given up, so the same words later are a new message.
        onChange={(body) => update({ body })}
        onSend={send}
      />
      <Dialog open={picker} onOpenChange={setPicker}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('kubecode.vocab.command.addContext')}</DialogTitle>
            <DialogDescription>{t('kubecode.channel.attachHint')}</DialogDescription>
          </DialogHeader>
          <ComposerProjectWorkPicker
            api={api}
            conversationId=""
            projectId={projectId}
            t={t}
            onSelect={pick}
          />
        </DialogContent>
      </Dialog>
    </div>
  )
}
