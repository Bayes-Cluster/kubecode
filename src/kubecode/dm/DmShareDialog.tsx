import { useState } from 'react'

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

import type { DmSharePreview, DmTurn, KubecodeApi, Member, ResearchSummary } from '../api'
import { ApiError } from '../api'
import { errorMessage } from '../app/errors'

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
  onShared: () => void
}

/**
 * Moves part of a private conversation into General, and only that part: the
 * researcher picks turns, may add a note, reads the exact text that would be
 * posted, and confirms that same text. Changing anything invalidates the
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
  const [preview, setPreview] = useState<DmSharePreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const request = () => ({
    runIds: turns.filter((turn) => chosen.includes(turn.run_id)).map((turn) => turn.run_id),
    note: note.trim() || undefined,
    taskId: taskId || null,
  })

  const changed = (action: () => void) => {
    // Any change to what would be shared makes the previous preview stale.
    action()
    setPreview(null)
    setError(null)
  }

  const toggle = (runId: string) => changed(() => setChosen((current) => (
    current.includes(runId)
      ? current.filter((id) => id !== runId)
      : current.length < MAX_TURNS ? [...current, runId] : current
  )))

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'dm_share_stale') {
        setPreview(null)
        setError(t('kubecode.dm.shareStale'))
      } else {
        setError(errorMessage(cause, t('kubecode.error')))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('kubecode.dm.shareTitle', { name: member.name })}</DialogTitle>
          <DialogDescription>{t('kubecode.dm.shareHelp')}</DialogDescription>
        </DialogHeader>
        <fieldset className="kubecode-dm-turns">
          <legend>{t('kubecode.dm.shareChoose')}</legend>
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
        {preview && (
          <section aria-label={t('kubecode.dm.sharePreview')} className="kubecode-dm-preview">
            <h4>{t('kubecode.dm.sharePreview')}</h4>
            <pre>{preview.text}</pre>
          </section>
        )}
        {error && <p className="kubecode-research-error" role="alert">{error}</p>}
        <div className="kubecode-work-command-row">
          {preview ? (
            <Button
              disabled={busy}
              size="sm"
              onClick={() => void run(async () => {
                await api.shareDm(projectId, member.id, { ...request(), digest: preview.digest })
                onShared()
                onOpenChange(false)
                setChosen([])
                setNote('')
                setPreview(null)
              })}
            >
              {t('kubecode.dm.shareConfirm')}
            </Button>
          ) : (
            <Button
              disabled={busy || chosen.length === 0}
              size="sm"
              onClick={() => void run(async () => {
                setPreview(await api.previewDmShare(projectId, member.id, request()))
              })}
            >
              {t('kubecode.dm.sharePreviewAction')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            {t('kubecode.members.cancel')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
