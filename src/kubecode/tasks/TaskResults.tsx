import { useEffect, useId, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { DecisionButton } from '@/components/workspace/DecisionButton'
import { ReferenceChip } from '@/components/workspace/ReferenceChip'
import { StatusBadge } from '@/components/workspace/StatusBadge'
import type { Translator } from '@/lib/i18n'

import {
  ApiError,
  type TaskDetail,
  type TaskEvidence,
  type TaskReviewRecord,
  type TaskReviewRequest,
  type WorkOutcome,
} from '../api'
import { errorMessage } from '../app/errors'
import { useInspectionRecord, useInspectorEntry, useInspectorServices } from '../app/inspector/inspectorContext'
import { placeKey, usePlaceState } from '../app/location/placeMemory'
import { ResearchFindingsPanel } from '../research/ResearchFindingsPanel'
import type { ResearchBundle } from '../research/useResearch'
import { evidenceKind, outcomeLabel, recordKindOf, taskTime } from './taskLabels'
import { useShowInGeneral } from './taskNavigation'
import { acceptBlocker, repinsFor, reviewEvidence, versionCheck, type VersionCheck } from './taskReview'

const OUTCOMES: Exclude<WorkOutcome, 'unknown'>[] = ['supported', 'refuted', 'inconclusive']

export type TaskResultsProps = {
  detail: TaskDetail
  projectId: string
  /** Reloads the Task after a decision, a refusal, or a record that changed under the researcher. */
  onChanged: () => void
  /** The research record behind the Task, for its findings; absent while it loads. */
  bundle?: ResearchBundle | null
  onBundleChanged?: () => void
}

type Decided = { requestId: string; accepted: boolean; outcome: WorkOutcome; messageId: string | null }

/**
 * A Task's results (ADR 0230 §3-§5): the open review with its evidence, each
 * changed record accepted only at the version the researcher was shown, the
 * scientific outcome (a well-supported negative result completes a Task), and
 * the decision, which reaches General with the researcher's feedback. A Done
 * Task shows what was accepted; earlier reviews and findings stay below.
 */
export function TaskResults({ bundle = null, detail, onBundleChanged, onChanged, projectId }: TaskResultsProps) {
  const { api, locale, t } = useInspectorServices()
  const showInGeneral = useShowInGeneral(detail.id)
  const [decided, setDecided] = useState<Decided | null>(null)
  // A request just decided is not offered again while the Task reloads.
  const openRequest = detail.review_requests.find((request) => (
    request.state === 'open' && request.id !== decided?.requestId
  )) ?? null
  const status = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (decided) status.current?.focus({ preventScroll: true })
  }, [decided])

  const accepted = [...detail.reviews].reverse().find((review) => review.accepted) ?? null
  const done = !openRequest && detail.stage === 'done'
  const earlier = detail.reviews.filter((review) => !(done && review === accepted))
  const acceptedEvidence = reviewEvidence(detail).accepted

  return (
    <div className="kubecode-task-results">
      {decided && !openRequest && (
        <p className="kubecode-task-decided" ref={status} role="status" tabIndex={-1}>
          {decided.accepted
            ? t('kubecode.task.decided.accepted', { outcome: outcomeLabel(t, decided.outcome) ?? '' })
            : t('kubecode.task.decided.returned')}
          {decided.messageId && (
            <>
              {' '}
              <Button size="xs" variant="ghost" onClick={() => showInGeneral(decided.messageId as string)}>
                {t('kubecode.task.showInGeneral')}
              </Button>
            </>
          )}
        </p>
      )}

      {openRequest && (
        <OpenReview
          detail={detail}
          key={openRequest.id}
          projectId={projectId}
          request={openRequest}
          onChanged={onChanged}
          onDecided={setDecided}
        />
      )}

      {done && accepted && (
        <section aria-label={t('kubecode.task.outcomeTitle')} className="kubecode-task-outcome-done">
          <h4>{t('kubecode.task.outcomeTitle')}</h4>
          <ReviewSummary review={accepted} locale={locale} t={t} onShow={showInGeneral} />
        </section>
      )}
      {done && acceptedEvidence.length > 0 && (
        <>
          <h4>{t('kubecode.task.acceptedEvidence')}</h4>
          <ul aria-label={t('kubecode.task.acceptedEvidence')} className="kubecode-task-evidence">
            {acceptedEvidence.map((row) => <li key={row.key}><EvidenceChip evidence={row} /></li>)}
          </ul>
        </>
      )}

      {!openRequest && !done && detail.reviews.length === 0 && (
        <p className="kubecode-research-muted">{t('kubecode.task.noResultsYet')}</p>
      )}

      {bundle && (
        <section aria-label={t('kubecode.task.findings')} className="kubecode-task-findings">
          <h4>{t('kubecode.task.findings')}</h4>
          <ResearchFindingsPanel
            api={api}
            detail={bundle.detail}
            findings={bundle.findings}
            outcomes={bundle.outcomes}
            proposals={bundle.proposals}
            rounds={bundle.rounds}
            t={t}
            onChanged={() => onBundleChanged?.()}
          />
        </section>
      )}

      {earlier.length > 0 && (
        <>
          <h4>{t('kubecode.task.earlierReviews')}</h4>
          <ul className="kubecode-task-reviews">
            {[...earlier].reverse().map((review) => (
              <li key={review.id}>
                <ReviewSummary review={review} locale={locale} t={t} onShow={showInGeneral} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function ReviewSummary({ locale, onShow, review, t }: {
  review: TaskReviewRecord
  locale?: string
  t: Translator
  onShow: (messageId: string) => void
}) {
  const outcome = review.accepted ? outcomeLabel(t, review.outcome) : null
  return (
    <div className="kubecode-task-review-summary">
      <StatusBadge tone={review.accepted ? 'ok' : 'warn'}>
        {review.accepted ? t('kubecode.task.accepted') : t('kubecode.task.returned')}
      </StatusBadge>
      {outcome && <StatusBadge tone="info">{outcome}</StatusBadge>}
      <small className="kubecode-research-muted">{t('kubecode.task.decidedAt', { time: taskTime(review.created_at, locale) })}</small>
      {review.reason && <q>{review.reason}</q>}
      {review.general_message_id && (
        <Button size="xs" variant="ghost" onClick={() => onShow(review.general_message_id as string)}>
          {t('kubecode.task.showInGeneral')}
        </Button>
      )}
    </div>
  )
}

/** A cited record as one chip; it opens over the Task, which stays mounted below it. */
function EvidenceChip({ evidence }: { evidence: TaskEvidence }) {
  const { t } = useInspectorServices()
  const open = useOpenEvidence(evidence)
  const kind = evidenceKind(t, evidence.kind)
  const pinned = evidence.cited_by.find((citation) => citation.pinned)?.pinned ?? null
  return (
    <ReferenceChip
      kind={kind.kind}
      kindLabel={kind.label}
      state={evidence.status === 'changed'
        ? { kind: 'changed', label: t('kubecode.task.evidenceState.changed') }
        : evidence.status === 'removed'
          ? { kind: 'removed', label: t('kubecode.task.evidenceState.removed') }
          : undefined}
      title={evidence.title ?? evidence.ref_id}
      version={pinned ? pinned.slice(0, 8) : undefined}
      onOpen={open ?? undefined}
    />
  )
}

function useOpenEvidence(evidence: TaskEvidence): (() => void) | null {
  const { push } = useInspectorEntry()
  const kind = recordKindOf(evidence.kind)
  if (!kind) return null
  const pinned = evidence.cited_by.find((citation) => citation.pinned)?.pinned ?? null
  return () => push(
    { kind: 'evidence', ref: { kind, id: evidence.ref_id, revision: pinned } },
    { from: `evidence:${evidence.key}` },
  )
}

function OpenReview({ detail, onChanged, onDecided, projectId, request }: {
  detail: TaskDetail
  projectId: string
  request: TaskReviewRequest
  onChanged: () => void
  onDecided: (decided: Decided) => void
}) {
  const { api, locale, t } = useInspectorServices()
  const record = useInspectionRecord()
  const memory = placeKey.task(projectId, detail.id)
  const [outcome, setOutcome] = usePlaceState<WorkOutcome>(`${memory}#outcome:${request.id}`, 'unknown')
  const [feedback, setFeedback] = usePlaceState(`${memory}#feedback:${request.id}`, '')
  const [ackRemoved, setAckRemoved] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const hintId = useId()

  const { other, review } = reviewEvidence(detail)
  const rows = [...review, ...other.filter((row) => row.status === 'changed' || row.status === 'removed')]
  const checks = new Map(rows.map((row) => [row.key, versionCheck(row, record.displayedRevision({ kind: row.kind, id: row.ref_id }))]))
  const removed = rows.some((row) => row.status === 'removed')

  // Shown at a version the list does not know yet: the list is reloaded once
  // for each version shown, so it catches up with the record.
  const reloaded = useRef(new Set<string>())
  const behind = rows
    .map((row) => {
      const check = checks.get(row.key)
      return check?.state === 'seen_older' ? `${row.key}@${check.seen}` : null
    })
    .filter((key): key is string => key !== null)
    .join('\n')
  useEffect(() => {
    if (!behind) return
    const fresh = behind.split('\n').filter((key) => !reloaded.current.has(key))
    if (fresh.length === 0) return
    fresh.forEach((key) => reloaded.current.add(key))
    onChanged()
  }, [behind, onChanged])

  const run = async (which: string, action: () => Promise<void>) => {
    setBusy(which)
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
      setBusy(null)
    }
  }

  const decide = (accept: boolean) => void run(accept ? 'accept' : 'return', async () => {
    const reason = feedback.trim()
    const verdict = await api.reviewTask(projectId, detail.id, accept
      ? { requestId: request.id, accept: true, outcome, reason: reason || undefined }
      : { requestId: request.id, accept: false, reason })
    onDecided({ requestId: request.id, accepted: accept, outcome, messageId: verdict?.general_message_id ?? null })
    setFeedback('')
    setOutcome('unknown')
  })

  const blocker = acceptBlocker(detail, ackRemoved, outcome)
  const acceptReason = blocker === null ? undefined : t(BLOCKER_TEXT[blocker])
  const returnReason = detail.archived
    ? t('kubecode.task.blocked.archived')
    : feedback.trim() === '' ? t('kubecode.task.blocked.reason') : undefined
  const requester = detail.timeline?.find((step) => step.kind === 'review_requested' && step.ref_id === request.id)?.member

  return (
    <section aria-label={t('kubecode.task.reviewTitle')} className="kubecode-task-review">
      <h4>{t('kubecode.task.reviewTitle')}</h4>
      <p className="kubecode-channel-body">{request.summary}</p>
      <p className="kubecode-research-muted">
        {requester
          ? t('kubecode.task.requestedBy', { name: requester.name, time: taskTime(request.created_at, locale) })
          : taskTime(request.created_at, locale)}
      </p>
      {rows.length > 0 && (
        <ul aria-label={t('kubecode.task.evidence')} className="kubecode-task-evidence">
          {rows.map((row) => (
            <EvidenceRow
              busy={busy === row.key}
              check={checks.get(row.key) as VersionCheck}
              evidence={row}
              key={row.key}
              onAccept={(revision) => void run(row.key, async () => {
                for (const citation of repinsFor(row)) {
                  await api.repinTaskEvidence(projectId, detail.id, citation, revision)
                }
              })}
            />
          ))}
        </ul>
      )}
      {removed && (
        <label className="kubecode-task-field">
          <span>
            <input checked={ackRemoved} type="checkbox" onChange={(event) => setAckRemoved(event.target.checked)} />
            {' '}{t('kubecode.task.ackRemoved')}
          </span>
        </label>
      )}
      <fieldset className="kubecode-task-outcome">
        <legend>{t('kubecode.work.review.outcome')}</legend>
        {OUTCOMES.map((value) => (
          <OutcomeChoice
            checked={outcome === value}
            key={value}
            name={`outcome-${request.id}`}
            t={t}
            value={value}
            onChoose={() => setOutcome(value)}
          />
        ))}
      </fieldset>
      <label className="kubecode-task-field">
        <span>{t('kubecode.task.feedback')}</span>
        <Textarea
          aria-describedby={hintId}
          rows={3}
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
        />
      </label>
      <small className="kubecode-research-muted" id={hintId}>{t('kubecode.task.feedbackHint')}</small>
      {error && <p className="kubecode-research-error" role="alert">{error}</p>}
      <div className="kubecode-task-decisions">
        <DecisionButton
          busy={busy === 'accept'}
          disabledReason={acceptReason}
          variant="primary"
          onDecide={() => decide(true)}
        >
          {t('kubecode.task.acceptResults')}
        </DecisionButton>
        <DecisionButton
          busy={busy === 'return'}
          disabledReason={returnReason}
          variant="secondary"
          onDecide={() => decide(false)}
        >
          {t('kubecode.task.sendBack')}
        </DecisionButton>
      </div>
    </section>
  )
}

const BLOCKER_TEXT = {
  archived: 'kubecode.task.blocked.archived',
  changed: 'kubecode.task.blocked.changed',
  removed_ack: 'kubecode.task.blocked.removed',
  outcome: 'kubecode.task.blocked.outcome',
} as const

function OutcomeChoice({ checked, name, onChoose, t, value }: {
  checked: boolean
  name: string
  t: Translator
  value: Exclude<WorkOutcome, 'unknown'>
  onChoose: () => void
}) {
  const hintId = useId()
  return (
    <div className="kubecode-task-outcome-choice">
      <label>
        <input aria-describedby={hintId} checked={checked} name={name} type="radio" value={value} onChange={onChoose} />
        {' '}{outcomeLabel(t, value)}
      </label>
      <small className="kubecode-research-muted" id={hintId}>{t(`kubecode.task.outcomeHint.${value}`)}</small>
    </div>
  )
}

function EvidenceRow({ busy, check, evidence, onAccept }: {
  evidence: TaskEvidence
  check: VersionCheck
  busy: boolean
  onAccept: (revision: string) => void
}) {
  const { t } = useInspectorServices()
  const open = useOpenEvidence(evidence)
  const changed = evidence.status === 'changed'
  return (
    <li className="kubecode-task-evidence-row" data-status={evidence.status}>
      <EvidenceChip evidence={evidence} />
      {changed && (
        <div className="kubecode-task-version">
          {open && (
            <Button data-focus-key={`evidence:${evidence.key}`} size="xs" variant="outline" onClick={open}>
              {t('kubecode.task.lookAtIt')}
            </Button>
          )}
          {check.state === 'seen_current' && (
            <small className="kubecode-research-muted">{t('kubecode.task.version.seenCurrent', { revision: check.seen.slice(0, 12) })}</small>
          )}
          <DecisionButton
            busy={busy}
            disabledReason={versionReason(t, check)}
            variant="secondary"
            onDecide={() => {
              if (check.state === 'seen_current') onAccept(check.seen)
            }}
          >
            {t('kubecode.task.acceptShown')}
          </DecisionButton>
        </div>
      )}
    </li>
  )
}

function versionReason(t: Translator, check: VersionCheck): string | undefined {
  switch (check.state) {
    case 'unseen': return t('kubecode.task.version.unseen')
    case 'unversioned': return t('kubecode.task.version.unversioned')
    case 'seen_older': return t('kubecode.task.version.seenOlder', { seen: check.seen.slice(0, 12) })
    default: return undefined
  }
}
