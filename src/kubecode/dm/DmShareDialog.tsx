import { useState } from 'react'

import { MarkdownContent } from '@/components/MarkdownContent'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { DecisionButton } from '@/components/workspace/DecisionButton'
import { ReferenceChip } from '@/components/workspace/ReferenceChip'
import type { Translator } from '@/lib/i18n'

import type { ChannelMessage, DmSharePreview, DmTurn, KubecodeApi, Member, ResearchSummary } from '../api'
import { ApiError } from '../api'
import { errorMessage } from '../app/errors'
import { Identity } from '../members/Identity'
import { useMemberDirectory } from '../members/memberDirectory'
import { memberView, researcherView } from '../members/memberIdentity'
import { newClientMessageId } from '../session/sessionModel'

/** Turns one share may carry (the server enforces the same bound). */
const MAX_TURNS = 6

export type DmShareDialogProps = {
  api: KubecodeApi
  member: Member
  open: boolean
  projectId: string
  research: ResearchSummary[]
  t: Translator
  turns: DmTurn[]
  onOpenChange: (open: boolean) => void
  /** The message it became in General. */
  onShared: (message: ChannelMessage) => void
}

/**
 * What a share would post, as General will show it (ADR 0229 §6): from the
 * researcher, to the project manager, about its Task, rendered the same way,
 * with the exact text a disclosure away.
 */
function DmSharePreviewCard({ preview, research, t }: { preview: DmSharePreview; research: ResearchSummary[]; t: Translator }) {
  const { manager } = useMemberDirectory()
  const task = preview.task_id ? research.find((item) => item.id === preview.task_id) : undefined
  return (
    <section aria-label={t('kubecode.dm.sharePreview')} className="kubecode-dm-preview">
      <Identity size="sm" view={researcherView(t)} />
      <p className="kubecode-message-recipients">
        <span className="kubecode-message-recipients-label">{t('kubecode.channel.to')}</span>
        {manager ? <Identity size="sm" view={memberView(manager, t)} /> : <span>{t('kubecode.channel.toManager')}</span>}
      </p>
      {preview.task_id && (
        <ReferenceChip
          kind="task"
          kindLabel={t('kubecode.vocab.object.task')}
          title={task?.title ?? t('kubecode.reference.untitled', { kind: t('kubecode.vocab.object.task') })}
        />
      )}
      <div className="kubecode-message-body">
        <MarkdownContent content={preview.text} images="text" />
      </div>
      <p className="kubecode-research-muted">
        {t('kubecode.dm.shareRecipients', { name: manager?.name ?? t('kubecode.channel.general') })}
      </p>
      <details>
        <summary>{t('kubecode.dm.shareExactText')}</summary>
        <pre>{preview.text}</pre>
      </details>
    </section>
  )
}

/**
 * Moves part of a private conversation into General, and only that part: the
 * researcher picks turns, may add a note, reads what would be posted as it
 * will look, and confirms that same text. Changing anything invalidates the
 * preview, and the server refuses a confirmation of text that no longer matches.
 */
export function DmShareDialog({
  api,
  member,
  onOpenChange,
  onShared,
  open,
  projectId,
  research,
  t,
  turns,
}: DmShareDialogProps) {
  const [chosen, setChosen] = useState<string[]>([])
  const [note, setNote] = useState('')
  const [taskId, setTaskId] = useState('')
  // The preview remembers what it was made from; one id belongs to one
  // confirmation, so a deliberate second share is a second message.
  const [made, setMade] = useState<{ preview: DmSharePreview; key: string; clientMessageId: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const request = () => ({
    runIds: turns.filter((turn) => chosen.includes(turn.run_id)).map((turn) => turn.run_id),
    note: note.trim() || undefined,
    taskId: taskId || null,
  })
  // A preview counts only for exactly what is selected now (the turns on
  // offer can change underneath a selection).
  const current = JSON.stringify(request())
  const preview = made && made.key === current ? made.preview : null

  const close = (next: boolean) => {
    if (!next) {
      setChosen([])
      setNote('')
      setTaskId('')
      setMade(null)
      setError(null)
    }
    onOpenChange(next)
  }

  const changed = (action: () => void) => {
    // Any change to what would be shared makes the previous preview stale.
    action()
    setMade(null)
    setError(null)
  }

  const toggle = (runId: string) => changed(() => setChosen((selected) => (
    selected.includes(runId)
      ? selected.filter((id) => id !== runId)
      : selected.length < MAX_TURNS ? [...selected, runId] : selected
  )))

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'dm_share_stale') {
        setMade(null)
        setError(t('kubecode.dm.shareStale'))
      } else {
        setError(errorMessage(cause, t('kubecode.error')))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="kubecode-dm-share">
        <DialogHeader>
          <DialogTitle>{t('kubecode.dm.shareTitle', { name: member.name })}</DialogTitle>
          <DialogDescription>{t('kubecode.dm.shareHelp')}</DialogDescription>
        </DialogHeader>
        <fieldset className="kubecode-dm-turns">
          <legend>{t('kubecode.dm.shareChoose')}</legend>
          <p className="kubecode-research-muted">{t('kubecode.dm.shareCount', { count: chosen.length, max: MAX_TURNS })}</p>
          {turns.length === 0 && <p className="kubecode-research-muted">{t('kubecode.dm.empty')}</p>}
          {turns.map((turn) => (
            <label key={turn.run_id}>
              <input
                checked={chosen.includes(turn.run_id)}
                disabled={!chosen.includes(turn.run_id) && chosen.length >= MAX_TURNS}
                type="checkbox"
                onChange={() => toggle(turn.run_id)}
              />
              <span>{turn.user.slice(0, 120) || turn.run_id.slice(0, 8)}</span>
            </label>
          ))}
        </fieldset>
        <label className="kubecode-dm-field">
          <span>{t('kubecode.dm.shareNote')}</span>
          <Textarea rows={2} value={note} onChange={(event) => changed(() => setNote(event.target.value))} />
        </label>
        {research.length > 0 && (
          <label className="kubecode-dm-field">
            <span>{t('kubecode.dm.shareTask')}</span>
            <select
              className="kubecode-channel-select"
              value={taskId}
              onChange={(event) => changed(() => setTaskId(event.target.value))}
            >
              <option value="">{t('kubecode.dm.shareNoTask')}</option>
              {research.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
          </label>
        )}
        {preview && <DmSharePreviewCard preview={preview} research={research} t={t} />}
        {error && <p className="kubecode-research-error" role="alert">{error}</p>}
        <div className="kubecode-work-command-row">
          {preview ? (
            <DecisionButton
              busy={busy}
              variant="primary"
              onDecide={() => void run(async () => {
                const message = await api.shareDm(projectId, member.id, {
                  ...request(),
                  digest: preview.digest,
                  clientMessageId: made?.clientMessageId,
                })
                onShared(message)
                close(false)
              })}
            >
              {t('kubecode.dm.shareConfirm')}
            </DecisionButton>
          ) : (
            <Button
              disabled={busy || chosen.length === 0}
              size="sm"
              onClick={() => void run(async () => {
                const key = JSON.stringify(request())
                setMade({
                  preview: await api.previewDmShare(projectId, member.id, request()),
                  key,
                  clientMessageId: newClientMessageId(),
                })
              })}
            >
              {t('kubecode.dm.sharePreviewAction')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => close(false)}>
            {t('kubecode.members.cancel')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
