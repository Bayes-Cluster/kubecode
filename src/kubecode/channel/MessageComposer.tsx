import { useContext, useEffect, useRef, useState, type Dispatch, type Ref, type SetStateAction } from 'react'

import {
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuItem,
  PromptInputActionMenuTrigger,
} from '@/components/ai-elements/prompt-input'
import { Button } from '@/components/ui/button'
import { DropdownMenuGroup } from '@/components/ui/dropdown-menu'
import { IconButton } from '@/components/workspace/IconButton'
import { ReferenceChip } from '@/components/workspace/ReferenceChip'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS } from '@/kubecode/icons/workspaceIcons'
import type { Translator } from '@/lib/i18n'

import { ApiError, type ChannelMessage, type KubecodeApi, type NewChannelMessage, type WorkspaceEvent } from '../api'
import { errorMessage } from '../app/errors'
import { placeKey, usePlaceRef } from '../app/location/placeMemory'
import { WorkspaceNavigationContext } from '../app/location/WorkspaceNavigation'
import { canReceive, type MemberDirectory } from '../members/memberDirectory'
import type { ReferenceLabelSource } from '../references/referenceLabels'
import { AddContextDialog } from '../resources/AddContextDialog'
import { attachAnnouncement, attachToDraft, draftHas, MAX_DRAFT_REFERENCES, type DraftReference } from '../resources/draftReferences'
import { useReferenceStatus } from '../resources/referenceStatus'
import { ResourceReferenceChip } from '../resources/ResourceReferenceChip'
import { newClientMessageId } from '../session/sessionModel'
import {
  draftRecipients,
  sendBlockedReason,
  toNewMessage,
  type GeneralDraft,
} from './generalDraft'
import { ConversationComposer } from './ConversationComposer'
import { mentionOptions } from './mentionOptions'
import { useOutbox, type OutboxItem } from './outbox'
import { OutboxRows } from './OutboxRows'

/**
 * What a General send carries: the message with each reference at the
 * version it was attached at (so Send again cites the same versions), and the
 * draft it came from for Edit.
 */
type GeneralSend = {
  message: Omit<NewChannelMessage, 'clientMessageId'>
  draft: Pick<GeneralDraft, 'body' | 'reply' | 'task' | 'taskRevision' | 'references'>
}

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
  /** General's Task filter: the draft's place, so finding something elsewhere returns here. */
  filter?: string | null
  /** The Workspace's name, for the search's scope. */
  workspaceName?: string
  events?: readonly WorkspaceEvent[]
  locale?: string
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
  events = [],
  filter = null,
  focusKey,
  locale,
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
  workspaceName = '',
}: MessageComposerProps) {
  const area = useRef<HTMLTextAreaElement | null>(null)
  const [picker, setPicker] = useState(false)
  // The Add context menu hands focus to the dialog it opens, or back to the text.
  const openingPicker = useRef(false)
  const outbox = useOutbox<GeneralSend>(outboxKey)
  const lastSent = useRef<GeneralDraft | null>(null)
  // The caret, kept while the researcher finds something to cite (the dialog, or Resources).
  const caretRef = usePlaceRef<{ start: number; end: number } | null>(`${placeKey.general(projectId, filter)}#caret`, null)
  const chips = useRef<HTMLUListElement>(null)
  const [announcement, setAnnouncement] = useState('')
  const [gate, setGate] = useState<string | null>(null)
  const statuses = useReferenceStatus(draft.references.map((item) => item.ref))
  const navigation = useContext(WorkspaceNavigationContext)
  const recipients = draftRecipients(draft.body, directory)
  const blocked = sendBlockedReason(recipients, t)
  const ready = draft.body.trim().length > 0 && blocked === null
  const update = (patch: Partial<GeneralDraft>) => onDraftChange((current) => ({ ...current, ...patch }))
  const focusText = () => area.current?.focus()
  const saveCaret = () => {
    const box = area.current
    if (box) caretRef.current = { start: box.selectionStart, end: box.selectionEnd }
  }
  // Back at the text box (the dialog closed, or Resources returned here): the caret is where it was.
  useEffect(() => {
    const box = area.current
    if (!box) return undefined
    const restore = () => {
      const saved = caretRef.current
      if (!saved) return
      caretRef.current = null
      box.setSelectionRange(saved.start, saved.end)
    }
    box.addEventListener('focus', restore)
    if (document.activeElement === box) restore()
    return () => box.removeEventListener('focus', restore)
  }, [caretRef])
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
    // A dropped connection rejects fetch with the browser's own, untranslated words.
    if (cause instanceof TypeError) return t('kubecode.error')
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
    // A reference to something that no longer exists cannot be sent; the chip says so.
    const gone = statuses.findIndex((status) => status.status === 'ready' && status.availability === 'removed')
    if (gone >= 0) {
      const item = draft.references[gone]
      const title = (statuses[gone].status === 'ready' && statuses[gone].title) || item.title
      setGate(t('kubecode.reference.sendBlockedRemoved', { title }))
      // After the composer has taken focus back from the send it refused.
      requestAnimationFrame(() => chipButton(item)?.focus())
      return
    }
    setGate(null)
    lastSent.current = draft
    // The message pins each reference (and the Task) at the version attached, so
    // Send again of this row cites exactly what was attached, under the same id.
    const { message } = toNewMessage(draft, recipients)
    const item = {
      id: newClientMessageId(),
      text: draft.body,
      payload: {
        message,
        draft: {
          body: draft.body, reply: draft.reply, task: draft.task, taskRevision: draft.taskRevision ?? null, references: draft.references,
        },
      },
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
      taskRevision: item.payload.draft.taskRevision ?? null,
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

  const chipButton = (item: DraftReference) => Array.from(chips.current?.querySelectorAll<HTMLElement>('[data-reference]') ?? [])
    .find((host) => host.dataset.reference === `${item.ref.kind}:${item.ref.id}`)
    ?.querySelector<HTMLElement>('button')

  const attach = (reference: DraftReference) => {
    const { result } = attachToDraft(draft, reference)
    const announcement = attachAnnouncement(result)
    if (announcement) {
      onDraftChange((current) => attachToDraft(current, reference).draft)
      setGate(null)
      setAnnouncement(t(announcement, { title: reference.title }))
    }
    return result
  }

  // Removing a chip moves focus to the next chip, or back to the text.
  const removeReference = (index: number) => {
    const item = draft.references[index]
    onDraftChange((current) => ({
      ...current,
      references: current.references.filter((existing) => existing.ref.kind !== item.ref.kind || existing.ref.id !== item.ref.id),
    }))
    setGate(null)
    const next = draft.references[index + 1] ?? draft.references[index - 1]
    requestAnimationFrame(() => {
      const chip = next && chipButton(next)
      if (chip) chip.focus()
      else focusText()
    })
  }

  // No recipient row (#229): only what still needs the researcher shows in the card.
  const manager = recipients.kind === 'manager' ? recipients.manager : null
  const notice = recipients.kind === 'unknown'
    ? recipients.status === 'loading'
      ? <span className="kubecode-composer-hint">{t('kubecode.members.loading')}</span>
      : (
        <span className="kubecode-composer-warning">
          {t('kubecode.members.loadFailed')}{' '}
          <Button size="xs" variant="ghost" onClick={() => directory.reload()}>{t('kubecode.members.retryLoad')}</Button>
        </span>
      )
    : recipients.kind === 'manager' && !(manager && canReceive(manager))
      ? <span className="kubecode-composer-warning">{t('kubecode.channel.noRecipient')}</span>
      : null
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
      {/* One input surface (#232): what it replies to and cites, the text with its tools, and what still needs the researcher. */}
      <ConversationComposer
        canSend={ready}
        focusKey={focusKey}
        header={(draft.reply || taskLabel || draft.references.length > 0) ? (
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
                <ul aria-label={t('kubecode.channel.references')} ref={chips}>
                  {taskLabel && (
                    <li>
                      <ReferenceChip
                        kind="task"
                        kindLabel={taskLabel.kindLabel}
                        removeLabel={t('kubecode.channel.removeTask', { title: taskLabel.title })}
                        title={taskLabel.title}
                        onRemove={() => {
                          update({ task: null, taskRevision: null, taskCleared: true })
                          focusText()
                        }}
                      />
                    </li>
                  )}
                  {draft.references.map((item, index) => {
                    const title = item.title || labels(item.ref).title
                    return (
                      <li key={`${item.ref.kind}:${item.ref.id}`}>
                        <ResourceReferenceChip
                          basis="attached"
                          knownTitle={title}
                          reference={item.ref}
                          removeLabel={t('kubecode.channel.removeReference', { title })}
                          t={t}
                          onOpen={navigation ? () => navigation.openReference(item.ref) : undefined}
                          onRemove={() => removeReference(index)}
                        />
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}
          </>
        ) : undefined}
        label={placeholder}
        mentionLabel={t('kubecode.composer.mentions')}
        mentions={mentionOptions(directory, t)}
        notices={(notice || (blocked && draft.body.trim() !== '') || gate) ? (
          <>
            {notice && <p className="kubecode-composer-notice">{notice}</p>}
            {blocked && draft.body.trim() !== '' && <p className="kubecode-composer-warning" role="status">{blocked}</p>}
            {gate && <p className="kubecode-research-error" role="alert">{gate}</p>}
          </>
        ) : undefined}
        placeholder={placeholder}
        sendDisabledReason={blocked ?? undefined}
        sendLabel={t('kubecode.channel.send')}
        stop={stop}
        textareaRef={setArea}
        tools={(
          // Add context (ADR 0242): one menu for what a message can carry besides its words.
          <PromptInputActionMenu>
            <PromptInputActionMenuTrigger aria-label={t('kubecode.vocab.command.addContext')} className="kubecode-add-context" tooltip={t('kubecode.vocab.command.addContext')}>
              <Icon role="command" source={WORKSPACE_COMMAND_ICONS.addContext.Icon} />
            </PromptInputActionMenuTrigger>
            <PromptInputActionMenuContent
              onCloseAutoFocus={(event) => {
                // The dialog takes focus when it opens; otherwise back to the text.
                event.preventDefault()
                if (openingPicker.current) openingPicker.current = false
                else focusText()
              }}
            >
              <DropdownMenuGroup>
                <PromptInputActionMenuItem
                  onSelect={() => {
                    saveCaret()
                    openingPicker.current = true
                    setPicker(true)
                  }}
                >
                  <Icon role="command" source={WORKSPACE_COMMAND_ICONS.addContext.Icon} />
                  {t('kubecode.composer.attachFromWorkspace')}
                </PromptInputActionMenuItem>
                <PromptInputActionMenuItem onSelect={insertMention}>
                  <Icon role="command" source={WORKSPACE_COMMAND_ICONS.mention.Icon} />
                  {t('kubecode.vocab.command.mention')}
                </PromptInputActionMenuItem>
              </DropdownMenuGroup>
            </PromptInputActionMenuContent>
          </PromptInputActionMenu>
        )}
        value={draft.body}
        // Emptied by hand: the draft is given up, so the same words later are a new message.
        onChange={(body) => update({ body })}
        onSend={send}
      />
      <span className="sr-only" role="status">{announcement}</span>
      {(
        <AddContextDialog
          api={api}
          events={events}
          filter={filter}
          full={draft.references.length >= MAX_DRAFT_REFERENCES}
          has={(ref) => draftHas(draft, ref)}
          locale={locale}
          open={picker}
          placeMemoryKey={placeKey.general(projectId, filter)}
          projectId={projectId}
          t={t}
          workspaceName={workspaceName}
          onAttach={attach}
          onCloseAutoFocus={(event) => {
            // Back to the text, with the caret where it was.
            event.preventDefault()
            focusText()
          }}
          onLeave={saveCaret}
          onOpenChange={setPicker}
        />
      )}
    </div>
  )
}
