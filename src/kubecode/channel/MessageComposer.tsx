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

const MAX_REFERENCES = 16

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
  /** Saves the message; resolves with it once it is stored. */
  onSend: (message: NewChannelMessage) => Promise<ChannelMessage>
  onSent?: (message: ChannelMessage) => void
  /** Stops one named task or agent; sending stays available while it runs. */
  stop?: { target: string; onStop: () => void }
}

/**
 * Writes one General message (ADR 0229 §4–§6): the text, whom it goes to (the
 * members it @mentions, or the project manager), the Task it is about and its
 * references, and the message it replies to. There are no message types. A
 * failed send puts everything back, and a retry of the same draft replays the
 * same message.
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
  placeholder,
  projectId,
  stop,
  t,
  textareaRef,
}: MessageComposerProps) {
  const hintId = useId()
  const area = useRef<HTMLTextAreaElement | null>(null)
  const [picker, setPicker] = useState(false)
  const [busy, setBusy] = useState(false)
  const error = draft.failure
  const sending = useRef(false)
  const recipients = draftRecipients(draft.body, directory)
  const blocked = sendBlockedReason(recipients, t)
  const ready = draft.body.trim().length > 0 && blocked === null
  const update = (patch: Partial<GeneralDraft>) => onDraftChange((current) => ({ ...current, ...patch }))
  const focusText = () => area.current?.focus()
  const setArea = (node: HTMLTextAreaElement | null) => {
    area.current = node
    if (typeof textareaRef === 'function') textareaRef(node)
    else if (textareaRef) textareaRef.current = node
  }

  const send = async () => {
    // A second call before the first settles must not clear the draft again.
    if (!ready || sending.current) return
    sending.current = true
    setBusy(true)
    const sent = draft
    const { message, signature } = toNewMessage(sent, recipients)
    const id = sent.attempt?.signature === signature ? sent.attempt.id : newClientMessageId()
    // Clear at once so what is typed next is never lost to this send; the Task
    // stays, and so does the attempt until the send succeeds.
    onDraftChange((current) => ({
      ...current, body: '', reply: null, references: [], attempt: { id, signature }, failure: null,
    }))
    try {
      const saved = await onSend({ ...message, clientMessageId: id })
      onDraftChange((current) => ({ ...current, attempt: current.attempt?.id === id ? null : current.attempt }))
      onSent?.(saved)
    } catch (cause) {
      let failure: string
      if (cause instanceof ApiError && cause.code === 'mention_unavailable') {
        const named = cause.memberId ? directory.byId.get(cause.memberId) : undefined
        failure = named
          ? t('kubecode.channel.mentionUnavailable', { name: named.name })
          : t('kubecode.channel.mentionUnavailableUnknown')
        directory.reload()
      } else {
        failure = errorMessage(cause, t('kubecode.error'))
      }
      // Put back what was sent, never over what the researcher has changed
      // since: new text follows it, and a Task chosen meanwhile stays.
      onDraftChange((current) => ({
        ...current,
        body: current.body === '' ? sent.body : `${sent.body}\n${current.body}`,
        reply: current.reply ?? sent.reply,
        references: current.references.length > 0 ? current.references : sent.references,
        failure,
      }))
    } finally {
      sending.current = false
      setBusy(false)
    }
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
            {blocked && draft.body.trim() && <p className="kubecode-composer-warning" role="status">{blocked}</p>}
            <p className="kubecode-composer-hint" id={hintId}>{t('kubecode.channel.authorizationHint')}</p>
            {error && (
              <p className="kubecode-research-error" role="alert">
                {error}{' '}
                <Button disabled={busy} size="xs" variant="ghost" onClick={() => void send()}>
                  {t('kubecode.vocab.command.retry')}
                </Button>
              </p>
            )}
          </>
        )}
        busy={busy}
        busyLabel={t('kubecode.channel.sending')}
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
        stop={stop && { label: t('kubecode.composer.stopTarget', { target: stop.target }), onStop: stop.onStop }}
        textareaRef={setArea}
        value={draft.body}
        // Emptied by hand: the draft is given up, so the same words later are a new message.
        onChange={(body) => update(body.trim() === '' ? { body, attempt: null, failure: null } : { body })}
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
