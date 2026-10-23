import { useId, useRef, useState } from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'
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
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
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
  const fieldId = useId()
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
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${fieldId}-title`}>{t('kubecode.research.field.title')}</FieldLabel>
            <Input id={`${fieldId}-title`} value={title} maxLength={200} onChange={(event) => {
                requestId.current = newClientMessageId()
                setTitle(event.target.value)
              }} />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${fieldId}-question`}>{t('kubecode.research.field.question')}</FieldLabel>
            <Textarea
              id={`${fieldId}-question`}
              rows={4}
              value={question}
              maxLength={4000}
              onChange={(event) => {
                requestId.current = newClientMessageId()
                setQuestion(event.target.value)
              }}
            />
          </Field>
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        </FieldGroup>
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
