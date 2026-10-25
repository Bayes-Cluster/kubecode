import { useId, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Field, FieldLabel } from '@/components/ui/field'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item'
import { Textarea } from '@/components/ui/textarea'

import type { TaskDetail } from '../api'
import { errorMessage } from '../app/errors'
import { useInspectorServices } from '../app/inspector/inspectorContext'
import { placeKey, usePlaceState } from '../app/location/placeMemory'
import { resolveThrough, useAttention } from '../attention/attentionContext'
import { ReaderNotice } from '../resources/ReaderStates'

type Question = TaskDetail['open_questions'][number]

/**
 * What specialists asked the researcher about a Task, answered in place. An
 * answer grants nothing; it is recorded on the work and reaches the member.
 */
export function TaskQuestions({ detail, onChanged, projectId }: {
  detail: TaskDetail
  projectId: string
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="flex flex-col gap-2">
      {error && <ReaderNotice failed>{error}</ReaderNotice>}
      <ItemGroup className="gap-2">
        {detail.open_questions.map((question) => (
          <QuestionItem
            busy={busy}
            key={question.id}
            memoryKey={`${placeKey.task(projectId, detail.id)}#answer:${question.id}`}
            question={question}
            onError={setError}
            onBusy={setBusy}
            onAnswered={onChanged}
            projectId={projectId}
          />
        ))}
      </ItemGroup>
    </div>
  )
}

function QuestionItem({ busy, memoryKey, onAnswered, onBusy, onError, projectId, question }: {
  busy: boolean
  memoryKey: string
  projectId: string
  question: Question
  onAnswered: () => void
  onBusy: (busy: boolean) => void
  onError: (error: string | null) => void
}) {
  const { api, t } = useInspectorServices()
  const attention = useAttention()
  const [answer, setAnswer] = usePlaceState(memoryKey, '')
  const send = async (text: string) => {
    onBusy(true)
    onError(null)
    try {
      // Answered once: Needs you, the bell and this panel resolve together (ADR 0232).
      await resolveThrough(attention, `question:${question.id}`, () => api.answerWorkDecision(projectId, question.work_id, question.id, text))
      setAnswer('')
      onAnswered()
    } catch (cause) {
      onError(errorMessage(cause, t('kubecode.error')))
    } finally {
      onBusy(false)
    }
  }
  const fieldId = useId()
  // One question as an official Item: what is asked and why, then its answer (#259).
  return (
    <Item data-focus-key={`question:${question.id}`} role="listitem" size="sm" tabIndex={-1} variant="outline">
      <ItemContent className="gap-2">
        <ItemTitle className="[overflow-wrap:anywhere]">{question.question}</ItemTitle>
        <ItemDescription>({question.work_title})</ItemDescription>
        {question.impact && <ItemDescription className="line-clamp-none">{question.impact}</ItemDescription>}
        {/* A question with options is answered with one of them (the server refuses anything else). */}
        {question.options.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {question.options.map((option) => (
              <Button disabled={busy} key={option} size="xs" variant="outline" onClick={() => void send(option)}>
                {option}
              </Button>
            ))}
          </div>
        ) : (
          <Field>
            <FieldLabel className="sr-only" htmlFor={fieldId}>{t('kubecode.task.answerField')}</FieldLabel>
            <Textarea id={fieldId} rows={2} value={answer} onChange={(event) => setAnswer(event.target.value)} />
            <div>
              <Button disabled={busy || answer.trim() === ''} size="xs" onClick={() => void send(answer.trim())}>
                {t('kubecode.work.question.answer')}
              </Button>
            </div>
          </Field>
        )}
      </ItemContent>
    </Item>
  )
}
