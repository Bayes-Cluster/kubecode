import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

import type { TaskDetail } from '../api'
import { errorMessage } from '../app/errors'
import { useInspectorServices } from '../app/inspector/inspectorContext'
import { placeKey, usePlaceState } from '../app/location/placeMemory'
import { resolveThrough, useAttention } from '../attention/attentionContext'

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
    <div className="kubecode-task-questions">
      {error && <p className="kubecode-research-error" role="alert">{error}</p>}
      <ul>
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
      </ul>
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
  return (
    <li data-focus-key={`question:${question.id}`} tabIndex={-1}>
      <p><strong>{question.question}</strong> <small>({question.work_title})</small></p>
      {question.impact && <p className="kubecode-research-muted">{question.impact}</p>}
      {/* A question with options is answered with one of them (the server refuses anything else). */}
      {question.options.length > 0 ? (
        <div className="kubecode-work-command-row">
          {question.options.map((option) => (
            <Button disabled={busy} key={option} size="xs" variant="outline" onClick={() => void send(option)}>
              {option}
            </Button>
          ))}
        </div>
      ) : (
        <>
          <label>
            <span className="sr-only">{t('kubecode.task.answerField')}</span>
            <Textarea rows={2} value={answer} onChange={(event) => setAnswer(event.target.value)} />
          </label>
          <Button disabled={busy || answer.trim() === ''} size="xs" onClick={() => void send(answer.trim())}>
            {t('kubecode.work.question.answer')}
          </Button>
        </>
      )}
    </li>
  )
}
