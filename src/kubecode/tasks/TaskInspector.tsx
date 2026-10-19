import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { StatusBadge } from '@/components/workspace/StatusBadge'
import type { Translator } from '@/lib/i18n'

import {
  ApiError,
  type KubecodeApi,
  type TaskDetail,
  type TaskReviewRequest,
  type TaskStaleEvidence,
  type WorkOutcome,
  type WorkspaceEvent,
} from '../api'
import { errorMessage } from '../app/errors'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'
import { EvidenceViewer, type EvidenceTarget } from '../work/EvidenceViewer'
import { conditionLabel, stageLabel } from './taskLabels'
import { useTaskDetail } from './useTaskDetail'

const OUTCOMES: Exclude<WorkOutcome, 'unknown'>[] = ['supported', 'refuted', 'inconclusive']

export type TaskInspectorProps = {
  api: KubecodeApi
  connectionState: WorkspaceConnectionState
  events: WorkspaceEvent[]
  projectId: string
  t: Translator
  taskId: string
  /** Goes to the researcher's message that added the Task, in General. */
  onShowMessage: (messageId: string) => void
}

/**
 * What a Task is, as the researcher needs it to decide: where it stands, who
 * authorized it and who works on it, what waits on them, and the results the
 * manager asked them to review — with the evidence behind them and a refusal to
 * accept evidence that changed since it was attached. A proposal that is not
 * on the board says so and where to put it there.
 */
export function TaskInspector({ api, connectionState, events, onShowMessage, projectId, t, taskId }: TaskInspectorProps) {
  const { detail, reload, status } = useTaskDetail(api, projectId, taskId, events, connectionState)

  if (status === 'loading') return <p className="kubecode-research-muted" role="status">{t('kubecode.task.loading')}</p>
  if (status === 'error') {
    return (
      <p className="kubecode-research-error" role="alert">
        {t('kubecode.task.loadFailed')}{' '}
        <Button size="xs" variant="ghost" onClick={reload}>{t('kubecode.retry')}</Button>
      </p>
    )
  }
  if (!detail) {
    return <p className="kubecode-research-notice" role="status">{t('kubecode.task.notOnBoard')}</p>
  }
  return <Inspector api={api} detail={detail} projectId={projectId} t={t} onChanged={reload} onShowMessage={onShowMessage} />
}

function Inspector({
  api,
  detail,
  onChanged,
  onShowMessage,
  projectId,
  t,
}: {
  api: KubecodeApi
  detail: TaskDetail
  onChanged: () => void
  onShowMessage: (messageId: string) => void
  projectId: string
  t: Translator
}) {
  const condition = conditionLabel(t, detail.condition)
  const manager = detail.participants.find((member) => member.role === 'general')
  const specialists = detail.participants.filter((member) => member.role !== 'general')
  const openRequest = detail.review_requests.find((request) => request.state === 'open') ?? null
  return (
    <section aria-label={t('kubecode.task.inspector')} className="kubecode-task-inspector">
      <div className="kubecode-task-inspector-status">
        <StatusBadge tone={detail.stage === 'review' ? 'info' : detail.stage === 'done' ? 'ok' : 'muted'}>
          {stageLabel(t, detail.stage)}
        </StatusBadge>
        {condition && <StatusBadge title={detail.condition_reason ?? undefined} tone="warn">{condition}</StatusBadge>}
        {detail.outcome && detail.outcome !== 'unknown' && (
          <StatusBadge tone="ok">{t(`kubecode.work.outcome.${detail.outcome}` as 'kubecode.work.outcome.refuted')}</StatusBadge>
        )}
        <span className="kubecode-research-muted">
          {t('kubecode.task.revisions', { revision: detail.revision, approved: detail.approved_revision })}
        </span>
      </div>
      {detail.revision > detail.approved_revision && (
        <p className="kubecode-research-notice" role="status">
          {t('kubecode.task.staleApproval', { approved: detail.approved_revision })}
        </p>
      )}
      <p className="kubecode-task-provenance">
        {detail.origin === 'legacy_round' || !detail.authorizing_message
          ? t('kubecode.task.legacyOrigin')
          : (
            <>
              <span>{t('kubecode.task.addedBy')}</span>
              <q>{detail.authorizing_message.body}</q>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => onShowMessage((detail.authorizing_message as { id: string }).id)}
              >
                {t('kubecode.task.showMessage')}
              </Button>
            </>
          )}
      </p>
      <p className="kubecode-task-participants">
        {manager && (
          <span>
            <StatusBadge tone="info">{t('kubecode.task.manager')}</StatusBadge> @{manager.handle}
          </span>
        )}
        {specialists.map((member) => (
          <span key={member.member_id}>
            <StatusBadge tone="muted">{t('kubecode.task.specialist')}</StatusBadge> @{member.handle}
          </span>
        ))}
        {detail.participants.length === 0 && (
          <span className="kubecode-research-muted">{t('kubecode.task.noParticipants')}</span>
        )}
      </p>

      {detail.open_questions.length > 0 && (
        <OpenQuestions api={api} detail={detail} projectId={projectId} t={t} onChanged={onChanged} />
      )}

      {openRequest && (
        <ReviewPanel
          api={api}
          key={openRequest.id}
          detail={detail}
          projectId={projectId}
          request={openRequest}
          t={t}
          onChanged={onChanged}
        />
      )}

      <h4>{t('kubecode.task.internalWork')}</h4>
      {detail.internal_work.length === 0
        ? <p className="kubecode-research-muted">{t('kubecode.task.noInternalWork')}</p>
        : (
          <ul className="kubecode-task-work">
            {detail.internal_work.map((work) => (
              <li key={work.id}>
                <strong>{work.title}</strong>
                <StatusBadge tone="muted">{t(`kubecode.work.stage.${work.stage}` as 'kubecode.work.stage.ready')}</StatusBadge>
                {work.assignee && <small>@{work.assignee.handle}</small>}
                <small className="kubecode-research-muted">
                  {t('kubecode.task.workCounts', { attempts: work.attempts, experiments: work.experiments })}
                </small>
              </li>
            ))}
          </ul>
        )}

      {detail.reviews.length > 0 && (
        <>
          <h4>{t('kubecode.task.earlierReviews')}</h4>
          <ul className="kubecode-task-reviews">
            {detail.reviews.map((review) => (
              <li key={review.id}>
                <StatusBadge tone={review.accepted ? 'ok' : 'warn'}>
                  {review.accepted ? t('kubecode.task.accepted') : t('kubecode.task.returned')}
                </StatusBadge>
                {review.accepted && review.outcome !== 'unknown' && (
                  <span>{t(`kubecode.work.outcome.${review.outcome}` as 'kubecode.work.outcome.refuted')}</span>
                )}
                {review.reason && <q>{review.reason}</q>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

function OpenQuestions({
  api,
  detail,
  onChanged,
  projectId,
  t,
}: {
  api: KubecodeApi
  detail: TaskDetail
  onChanged: () => void
  projectId: string
  t: Translator
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const answer = async (workId: string, requestId: string, text: string) => {
    setBusy(true)
    setError(null)
    try {
      await api.answerWorkDecision(projectId, workId, requestId, text)
      onChanged()
    } catch (cause) {
      setError(errorMessage(cause, t('kubecode.error')))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-label={t('kubecode.task.waitingOnYou')} className="kubecode-task-questions">
      <h4>{t('kubecode.task.waitingOnYou')}</h4>
      {error && <p className="kubecode-research-error" role="alert">{error}</p>}
      <ul>
        {detail.open_questions.map((request) => (
          <li key={request.id}>
            <p><strong>{request.question}</strong> <small>({request.work_title})</small></p>
            {request.impact && <p className="kubecode-research-muted">{request.impact}</p>}
            {request.options.length > 0 && (
              <div className="kubecode-work-command-row">
                {request.options.map((option) => (
                  <Button
                    disabled={busy}
                    key={option}
                    size="xs"
                    variant="outline"
                    onClick={() => void answer(request.work_id, request.id, option)}
                  >
                    {option}
                  </Button>
                ))}
              </div>
            )}
            <label>
              <span className="sr-only">{t('kubecode.task.answerField')}</span>
              <Textarea
                rows={2}
                value={answers[request.id] ?? ''}
                onChange={(event) => setAnswers({ ...answers, [request.id]: event.target.value })}
              />
            </label>
            <Button
              disabled={busy || (answers[request.id] ?? '').trim() === ''}
              size="xs"
              onClick={() => void answer(request.work_id, request.id, (answers[request.id] ?? '').trim())}
            >
              {t('kubecode.work.question.answer')}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}

type StaleGroup = {
  key: string
  kind: string
  refId: string
  status: TaskStaleEvidence['status']
  current: string | null
  entries: TaskStaleEvidence[]
}

/** One row per piece of evidence, however many pins of it are stale. */
function groupStale(stale: TaskStaleEvidence[]): StaleGroup[] {
  const groups = new Map<string, StaleGroup>()
  for (const entry of stale) {
    const key = `${entry.kind}:${entry.ref_id}`
    const group = groups.get(key)
    if (group) {
      group.entries.push(entry)
    } else {
      groups.set(key, {
        key, kind: entry.kind, refId: entry.ref_id, status: entry.status, current: entry.current, entries: [entry],
      })
    }
  }
  return [...groups.values()]
}

function ReviewPanel({
  api,
  detail,
  onChanged,
  projectId,
  request,
  t,
}: {
  api: KubecodeApi
  detail: TaskDetail
  onChanged: () => void
  projectId: string
  request: TaskReviewRequest
  t: Translator
}) {
  const [outcome, setOutcome] = useState<WorkOutcome>('unknown')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [looking, setLooking] = useState<EvidenceTarget | null>(null)
  // Evidence that changed can be accepted only at the version the researcher
  // looked at; if it changes again, it must be looked at again. Evidence that
  // is gone must be acknowledged instead. One piece of evidence may be pinned
  // more than once (by the work and by the review); it is looked at once and
  // accepting re-pins every pin of it.
  const [looked, setLooked] = useState<Record<string, string>>({})
  const lookedAtCurrent = (group: StaleGroup) => (
    group.current !== null && looked[group.key] === group.current
  )
  const [ackRemoved, setAckRemoved] = useState(false)
  const stale = detail.stale_evidence
  const groups = groupStale(stale)
  const changed = stale.filter((entry) => entry.status === 'changed')
  const removed = stale.filter((entry) => entry.status === 'removed')
  const evidence = request.evidence.map((entry) => {
    const [kind, ...rest] = entry.split(':')
    return { entry, target: { kind, id: rest.join(':') } as EvidenceTarget }
  }).filter((item, index, all) => all.findIndex((other) => other.entry === item.entry) === index)

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      onChanged()
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'work_evidence_stale') {
        setError(t('kubecode.task.evidenceStale'))
        onChanged()
      } else if (cause instanceof ApiError && cause.code === 'task_state') {
        setError(t('kubecode.task.reviewMoved'))
        onChanged()
      } else {
        setError(errorMessage(cause, t('kubecode.error')))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label={t('kubecode.task.reviewTitle')} className="kubecode-task-review">
      <h4>{t('kubecode.task.reviewTitle')}</h4>
      <p className="kubecode-channel-body">{request.summary}</p>
      {evidence.length > 0 && (
        <ul aria-label={t('kubecode.task.evidence')} className="kubecode-task-evidence">
          {evidence.map(({ entry, target }) => (
            <li key={entry}>
              <Button
                aria-expanded={looking?.kind === target.kind && looking?.id === target.id}
                size="xs"
                variant="outline"
                onClick={() => setLooking(looking?.kind === target.kind && looking?.id === target.id ? null : target)}
              >
                {entry}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {looking && (
        <EvidenceViewer api={api} key={`${looking.kind}:${looking.id}`} projectId={projectId} t={t} target={looking} />
      )}
      {stale.length > 0 && (
        <div className="kubecode-research-notice" role="status">
          <p>{t('kubecode.task.staleEvidenceTitle')}</p>
          <ul>
            {groups.map((group) => (
              <li key={group.key}>
                <span title={group.key}>
                  {group.key} — {t(group.status === 'removed' ? 'kubecode.task.evidenceRemoved' : 'kubecode.task.evidenceChanged')}
                </span>
                {group.status === 'changed' && (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setLooking({ kind: group.kind, id: group.refId, revision: group.current })
                      if (group.current) setLooked({ ...looked, [group.key]: group.current })
                    }}
                  >
                    {t('kubecode.task.lookAtIt')}
                  </Button>
                )}
                {group.status === 'changed' && (
                  <Button
                    disabled={busy || !lookedAtCurrent(group)}
                    size="xs"
                    title={lookedAtCurrent(group) ? undefined : t('kubecode.task.lookFirst')}
                    variant="outline"
                    onClick={() => {
                      const revision = looked[group.key]
                      void run(async () => {
                        for (const entry of group.entries) {
                          await api.repinTaskEvidence(projectId, detail.id, entry, revision)
                        }
                      })
                    }}
                  >
                    {t('kubecode.task.acceptCurrent')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {removed.length > 0 && changed.length === 0 && (
        <label className="kubecode-task-field">
          <span>
            <input checked={ackRemoved} type="checkbox" onChange={(event) => setAckRemoved(event.target.checked)} />
            {' '}{t('kubecode.task.ackRemoved')}
          </span>
        </label>
      )}
      <label className="kubecode-task-field">
        <span>{t('kubecode.work.review.outcome')}</span>
        <select
          className="kubecode-channel-select"
          value={outcome}
          onChange={(event) => setOutcome(event.target.value as WorkOutcome)}
        >
          <option value="unknown">{t('kubecode.task.chooseOutcome')}</option>
          {OUTCOMES.map((value) => (
            <option key={value} value={value}>
              {t(`kubecode.work.outcome.${value}` as 'kubecode.work.outcome.refuted')}
            </option>
          ))}
        </select>
      </label>
      <p className="kubecode-research-muted">{t('kubecode.task.negativeHint')}</p>
      <label className="kubecode-task-field">
        <span>{t('kubecode.task.reason')}</span>
        <Textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      {error && <p className="kubecode-research-error" role="alert">{error}</p>}
      <div className="kubecode-work-command-row">
        <Button
          disabled={busy || changed.length > 0 || (removed.length > 0 && !ackRemoved) || outcome === 'unknown'}
          size="sm"
          onClick={() => void run(() => api.reviewTask(projectId, detail.id, {
            requestId: request.id, accept: true, outcome, reason: reason.trim() || undefined,
          }))}
        >
          {t('kubecode.task.acceptResults')}
        </Button>
        <Button
          disabled={busy || reason.trim() === ''}
          size="sm"
          variant="outline"
          onClick={() => void run(() => api.reviewTask(projectId, detail.id, {
            requestId: request.id, accept: false, reason: reason.trim(),
          }))}
        >
          {t('kubecode.task.sendBack')}
        </Button>
      </div>
    </section>
  )
}
