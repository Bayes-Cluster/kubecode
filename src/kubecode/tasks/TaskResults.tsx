import { CircleCheck } from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'

import { Confirmation, ConfirmationActions, ConfirmationTitle } from '@/components/ai-elements/confirmation'
import { Sources } from '@/components/ai-elements/sources'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import { DecisionButton } from '@/components/workspace/DecisionButton'
import { ReferenceChip } from '@/components/workspace/ReferenceChip'
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
import { resolveThrough, useAttention } from '../attention/attentionContext'
import { fallbackTitle, formatVersion } from '../resources/referenceKinds'
import { ResearchFindingsPanel } from '../research/ResearchFindingsPanel'
import type { ResearchBundle } from '../research/useResearch'
import { ReaderEmpty, ReaderNotice } from '../resources/ReaderStates'
import { evidenceKind, outcomeLabel, recordKindOf, taskTime } from './taskLabels'
import { useShowInGeneral } from './taskNavigation'
import { StatusBadge } from '@/components/workspace/StatusBadge'
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
  const status = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (decided) status.current?.focus({ preventScroll: true })
  }, [decided])

  const accepted = [...detail.reviews].reverse().find((review) => review.accepted) ?? null
  const done = !openRequest && detail.stage === 'done'
  const earlier = detail.reviews.filter((review) => !(done && review === accepted))
  const acceptedEvidence = reviewEvidence(detail).accepted

  return (
    <div className="flex min-w-0 flex-col gap-4 pt-2">
      {decided && !openRequest && (
        // What was just decided, said once and focused, so the researcher's place is kept (#259: official Alert).
        <Alert className="outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" ref={status} role="status" tabIndex={-1}>
          <CircleCheck aria-hidden />
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <span>
              {decided.messageId === null
                ? t('kubecode.task.decided.notPosted')
                : decided.accepted
                  ? t('kubecode.task.decided.accepted', { outcome: outcomeLabel(t, decided.outcome) ?? '' })
                  : t('kubecode.task.decided.returned')}
            </span>
            {decided.messageId && (
              <Button className="pointer-coarse:min-h-11" size="xs" variant="outline" onClick={() => showInGeneral(decided.messageId as string)}>
                {t('kubecode.task.showInGeneral')}
              </Button>
            )}
          </AlertDescription>
        </Alert>
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
        <section aria-label={t('kubecode.task.outcomeTitle')} className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold">{t('kubecode.task.outcomeTitle')}</h4>
          <ReviewSummary review={accepted} locale={locale} t={t} onShow={showInGeneral} />
        </section>
      )}
      {done && acceptedEvidence.length > 0 && (
        <>
          <h4 className="text-sm font-semibold">{t('kubecode.task.acceptedEvidence')}</h4>
          <EvidenceSources label={t('kubecode.task.acceptedEvidence')}>
            {acceptedEvidence.map((row) => (
              <Item className="p-0" key={row.key} role="listitem" size="sm">
                <EvidenceChip evidence={row} />
              </Item>
            ))}
          </EvidenceSources>
        </>
      )}

      {!openRequest && !done && detail.reviews.length === 0 && (
        <ReaderEmpty>{t('kubecode.task.noResultsYet')}</ReaderEmpty>
      )}

      {bundle && (
        <section aria-label={t('kubecode.task.findings')} className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold">{t('kubecode.task.findings')}</h4>
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
          <h4 className="text-sm font-semibold">{t('kubecode.task.earlierReviews')}</h4>
          <ItemGroup className="gap-2">
            {[...earlier].reverse().map((review) => (
              <ReviewSummary key={review.id} review={review} locale={locale} t={t} onShow={showInGeneral} />
            ))}
          </ItemGroup>
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
  // One decided review as an official Item: the verdict and outcome, when, the researcher's words, and its message.
  return (
    <Item role="listitem" size="sm" variant="outline">
      <ItemContent className="gap-1">
        <ItemTitle className="flex flex-wrap items-center gap-1">
          <StatusBadge tone={review.accepted ? 'ok' : 'warn'}>
            {review.accepted ? t('kubecode.task.accepted') : t('kubecode.task.returned')}
          </StatusBadge>
          {outcome && <StatusBadge tone="info">{outcome}</StatusBadge>}
        </ItemTitle>
        <ItemDescription>{t('kubecode.task.decidedAt', { time: taskTime(review.created_at, locale) })}</ItemDescription>
        {review.reason && <q className="text-sm [overflow-wrap:anywhere]">{review.reason}</q>}
      </ItemContent>
      {review.general_message_id && (
        <ItemActions>
          <Button className="pointer-coarse:min-h-11" size="xs" variant="ghost" onClick={() => onShow(review.general_message_id as string)}>
            {t('kubecode.task.showInGeneral')}
          </Button>
        </ItemActions>
      )}
    </Item>
  )
}

/** Cited records as the official Sources, one Item row per record (ADR 0243). */
function EvidenceSources({ children, label }: { children: ReactNode; label: string }) {
  // The list is never folded, so Sources holds it without its trigger and content.
  return (
    <Sources className="mb-0" data-ws-sources="">
      <ItemGroup aria-label={label} className="gap-2" role="list">{children}</ItemGroup>
    </Sources>
  )
}

/** A cited record as one chip; it opens over the Task, which stays mounted below it. */
function EvidenceChip({ evidence }: { evidence: TaskEvidence }) {
  const { t } = useInspectorServices()
  const open = useOpenEvidence(evidence)
  const kind = evidenceKind(t, evidence.kind)
  const pinned = evidence.cited_by.find((citation) => citation.pinned)?.pinned ?? null
  // Named and versioned like every reference (ADR 0231 §5): never an id, never a raw fingerprint.
  const record = recordKindOf(evidence.kind)
  return (
    <ReferenceChip
      kind={kind.kind}
      kindLabel={kind.label}
      state={evidence.status === 'changed'
        ? { kind: 'changed', label: t('kubecode.task.evidenceState.changed') }
        : evidence.status === 'removed'
          ? { kind: 'removed', label: t('kubecode.task.evidenceState.removed') }
          : undefined}
      title={evidence.title ?? (record ? fallbackTitle({ kind: record, id: evidence.ref_id }, t) : kind.label)}
      version={record ? formatVersion(record, pinned, t) : undefined}
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
  const attention = useAttention()
  const record = useInspectionRecord()
  const memory = placeKey.task(projectId, detail.id)
  const [outcome, setOutcome] = usePlaceState<WorkOutcome>(`${memory}#outcome:${request.id}`, 'unknown')
  const [feedback, setFeedback] = usePlaceState(`${memory}#feedback:${request.id}`, '')
  const [ackRemoved, setAckRemoved] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const hintId = useId()
  const feedbackId = useId()
  const ackId = useId()
  const legendId = useId()
  const choiceId = useId()

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

  const [settled, setSettled] = useState<string | null>(null)

  const run = async (which: string, action: () => Promise<void>) => {
    setBusy(which)
    setError(null)
    setSettled(null)
    try {
      await action()
      onChanged()
    } catch (cause) {
      if (cause instanceof PartlyAccepted) {
        setError(t('kubecode.task.partlyAccepted'))
        onChanged()
      } else if (cause instanceof ApiError && cause.code === 'work_evidence_stale') {
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
    const verdict = await resolveThrough(attention, `review:${request.id}`, () => api.reviewTask(projectId, detail.id, accept
      ? { requestId: request.id, accept: true, outcome, reason: reason || undefined }
      : { requestId: request.id, accept: false, reason }))
    onDecided({ requestId: request.id, accepted: accept, outcome, messageId: verdict?.general_message_id ?? null })
    setFeedback('')
    setOutcome('unknown')
  })

  const blocker = acceptBlocker(detail, ackRemoved, outcome)
  // While one decision is being recorded, the other waits for it.
  const deciding = busy === 'accept' || busy === 'return' ? t('kubecode.task.blocked.deciding') : undefined
  const acceptReason = busy === 'return'
    ? deciding
    : blocker === null ? undefined : t(BLOCKER_TEXT[blocker])
  const returnReason = busy === 'accept'
    ? deciding
    : detail.archived
      ? t('kubecode.task.blocked.archived')
      : feedback.trim() === '' ? t('kubecode.task.blocked.reason') : undefined
  const requester = detail.timeline?.find((step) => step.kind === 'review_requested' && step.ref_id === request.id)?.member

  return (
    <Card
      aria-label={t('kubecode.task.reviewTitle')}
      className="gap-4 py-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      data-focus-key={`review:${request.id}`}
      role="region"
      tabIndex={-1}
    >
      <CardHeader className="px-4">
        <CardTitle>{t('kubecode.task.reviewTitle')}</CardTitle>
        <CardDescription>
          {requester
            ? t('kubecode.task.requestedBy', { name: requester.name, time: taskTime(request.created_at, locale) })
            : taskTime(request.created_at, locale)}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-4">
        <p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{request.summary}</p>
        {rows.length > 0 && (
          <EvidenceSources label={t('kubecode.task.evidence')}>
            {rows.map((row) => (
              <EvidenceRow
                busy={busy === row.key}
                check={checks.get(row.key) as VersionCheck}
                evidence={row}
                key={row.key}
                settle={settled === row.key}
                onAccept={(revision) => void run(row.key, async () => {
                  // One pin at a time: when a later one fails, the earlier ones
                  // stand, so the researcher is told only part was accepted.
                  let accepted = 0
                  try {
                    for (const citation of repinsFor(row)) {
                      await api.repinTaskEvidence(projectId, detail.id, citation, revision)
                      accepted += 1
                    }
                  } catch (cause) {
                    throw accepted > 0 ? new PartlyAccepted() : cause
                  }
                  setSettled(row.key)
                })}
              />
            ))}
          </EvidenceSources>
        )}
        <FieldGroup className="gap-4">
          {removed && (
            <Field orientation="horizontal">
              <Checkbox checked={ackRemoved} id={ackId} onCheckedChange={(checked) => setAckRemoved(checked === true)} />
              <FieldLabel className="font-normal" htmlFor={ackId}>{t('kubecode.task.ackRemoved')}</FieldLabel>
            </Field>
          )}
          <FieldSet>
            <FieldLegend id={legendId} variant="label">{t('kubecode.work.review.outcome')}</FieldLegend>
            <RadioGroup
              aria-labelledby={legendId}
              name={`outcome-${request.id}`}
              value={outcome === 'unknown' ? '' : outcome}
              onValueChange={(value) => setOutcome(value as WorkOutcome)}
            >
              {OUTCOMES.map((value) => (
                <OutcomeChoice idPrefix={choiceId} key={value} t={t} value={value} />
              ))}
            </RadioGroup>
          </FieldSet>
          <Field>
            <FieldLabel htmlFor={feedbackId}>{t('kubecode.task.feedback')}</FieldLabel>
            <Textarea
              aria-describedby={hintId}
              id={feedbackId}
              rows={3}
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
            />
            <FieldDescription id={hintId}>{t('kubecode.task.feedbackHint')}</FieldDescription>
          </Field>
        </FieldGroup>
        {error && <ReaderNotice failed>{error}</ReaderNotice>}
      </CardContent>
      <CardFooter className="kubecode-task-decisions bg-card px-4">
        {/* The official Confirmation, kept a named group: nothing here is an alert (ADR 0243). */}
        <Confirmation
          approval={{ id: request.id }}
          aria-label={t('kubecode.task.decisionTitle')}
          role="group"
          state="approval-requested"
        >
          <ConfirmationTitle>{t('kubecode.task.acceptsShownVersions')}</ConfirmationTitle>
          <ConfirmationActions className="flex-wrap justify-start">
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
          </ConfirmationActions>
        </Confirmation>
      </CardFooter>
    </Card>
  )
}

/** Some pins of a piece of evidence moved to the version shown, and then one failed. */
class PartlyAccepted extends Error {}

const BLOCKER_TEXT = {
  archived: 'kubecode.task.blocked.archived',
  changed: 'kubecode.task.blocked.changed',
  removed_ack: 'kubecode.task.blocked.removed',
  outcome: 'kubecode.task.blocked.outcome',
} as const

/** One scientific outcome: the official RadioGroupItem in a Field, its hint describing it. */
function OutcomeChoice({ idPrefix, t, value }: {
  idPrefix: string
  t: Translator
  value: Exclude<WorkOutcome, 'unknown'>
}) {
  const id = `${idPrefix}-${value}`
  return (
    <Field orientation="horizontal">
      <RadioGroupItem aria-describedby={`${id}-hint`} id={id} value={value} />
      <FieldContent>
        <FieldLabel className="font-normal" htmlFor={id}>{outcomeLabel(t, value)}</FieldLabel>
        <FieldDescription id={`${id}-hint`}>{t(`kubecode.task.outcomeHint.${value}`)}</FieldDescription>
      </FieldContent>
    </Field>
  )
}

function EvidenceRow({ busy, check, evidence, onAccept, settle }: {
  evidence: TaskEvidence
  check: VersionCheck
  busy: boolean
  /** The version shown was just accepted: once it is no longer changed, focus goes to the record. */
  settle: boolean
  onAccept: (revision: string) => void
}) {
  const { t } = useInspectorServices()
  const open = useOpenEvidence(evidence)
  const changed = evidence.status === 'changed'
  const row = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (settle && !changed) row.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })
  }, [changed, settle])
  return (
    <Item className="flex-col items-stretch p-0" data-status={evidence.status} ref={row} role="listitem" size="sm">
      <EvidenceChip evidence={evidence} />
      {changed && (
        <ItemActions className="flex-wrap items-start">
          {open && (
            <Button data-focus-key={`evidence:${evidence.key}`} className="pointer-coarse:min-h-11" size="xs" variant="outline" onClick={open}>
              {t('kubecode.task.lookAtIt')}
            </Button>
          )}
          {check.state === 'seen_current' && (
            <small className="basis-full text-muted-foreground">{t('kubecode.task.version.seenCurrent', { revision: check.seen.slice(0, 12) })}</small>
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
        </ItemActions>
      )}
    </Item>
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
