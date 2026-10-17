import { useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { Translator } from '@/lib/i18n'

import { errorMessage } from '../app/errors'
import type { KubecodeApi, ResearchDetail } from '../api'
import { newClientMessageId } from '../session/sessionModel'

/** Saving a question only records it: it never starts an Agent. */
export function NewResearchDialog({
  api,
  onCreated,
  onOpenChange,
  open,
  projectId,
  t,
}: {
  api: KubecodeApi
  onCreated: (created: ResearchDetail) => void
  onOpenChange: (open: boolean) => void
  open: boolean
  projectId: string | null
  t: Translator
}) {
  const [title, setTitle] = useState('')
  const [question, setQuestion] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // One key per attempt: a retry after a lost response returns the same RQ.
  const requestId = useRef(newClientMessageId())

  const valid = title.trim().length > 0 && question.trim().length > 0
  const submit = async () => {
    if (!projectId || !valid || saving) return
    setSaving(true)
    setError(null)
    try {
      const created = await api.createResearch(
        projectId,
        { title: title.trim(), question: question.trim() },
        requestId.current,
      )
      requestId.current = newClientMessageId()
      setTitle('')
      setQuestion('')
      onOpenChange(false)
      onCreated(created)
    } catch (cause) {
      setError(errorMessage(cause, t('kubecode.error')))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('kubecode.research.new')}</DialogTitle>
          <DialogDescription>{t('kubecode.research.newDescription')}</DialogDescription>
        </DialogHeader>
        <div className="kubecode-research-form">
          <label>
            <span>{t('kubecode.research.field.title')}</span>
            <Input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>
            <span>{t('kubecode.research.field.question')}</span>
            <Textarea
              rows={4}
              value={question}
              maxLength={4000}
              onChange={(event) => setQuestion(event.target.value)}
            />
          </label>
          {error && <p className="kubecode-research-error" role="alert">{error}</p>}
        </div>
        <DialogFooter>
          <DialogClose asChild><Button disabled={saving} variant="ghost">{t('kubecode.cancel')}</Button></DialogClose>
          <Button aria-busy={saving} disabled={!valid || saving || !projectId} onClick={() => void submit()}>
            {t('kubecode.research.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
