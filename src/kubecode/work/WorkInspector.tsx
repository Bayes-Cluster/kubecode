import { X } from 'lucide-react'
import { IconButton } from '@/components/workspace/IconButton'
import { StatusBadge } from '@/components/workspace/StatusBadge'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { Translator } from '@/lib/i18n'

import type {
  Conversation,
  KubecodeApi,
  WorkCommand,
  WorkLifecycle,
  WorkOutcome,
  WorkspaceEvent,
} from '../api'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'
import {
  CONDITION_LABELS,
  hasOpenAttempt,
  isStale,
  LIFECYCLE_LABELS,
  STAGE_LABELS,
  type StartKeys,
  workErrorMessage,
} from './workModel'
import { EvidenceViewer } from './EvidenceViewer'
import { useWorkDetail } from './useWorkBoard'

export type InspectorForm = 'assign' | 'accept' | 'reject' | 'close' | null

/** A form a drag asked for; the nonce makes asking again reopen a closed one. */
export type FormRequest = { form: InspectorForm; nonce: number }

export type WorkInspectorProps = {
  api: KubecodeApi
  connectionState: WorkspaceConnectionState
  events: WorkspaceEvent[]
  formRequest?: FormRequest
  /** Other active work a task can be superseded by. */
  replacements?: Array<{ id: string; title: string }>
  startKeys: StartKeys
  onChanged: () => void
  onClose: () => void
  onOpenResearch?: (researchId: string) => void
  onOpenSession?: (conversationId: string) => void
  onOpenTeam?: (teamId: string) => void
  onOpenThread?: (threadId: string) => void
  projectId: string
  refreshKey?: string
  /** Sessions of this Project the researcher may assign. */
  sessions: Conversation[]
  t: Translator
  workId: string
}

const OUTCOMES: WorkOutcome[] = ['unknown', 'supported', 'refuted', 'inconclusive']

/**
 * One card with everything that explains it: requirements, sources, attempts
 * and Sessions, experiments, evidence, reviews, and deliveries. The commands
 * are the work store's, revision-checked against the card as shown here.
 */
export function WorkInspector({
  api,
  connectionState,
  events,
  formRequest,
  replacements = [],
  startKeys,
  onChanged,
  onClose,
  onOpenResearch,
  onOpenSession,
  onOpenTeam,
  onOpenThread,
  projectId,
  refreshKey,
  sessions,
  t,
  workId,
}: WorkInspectorProps) {
  const { detail, reload, status } = useWorkDetail(
    api,
    projectId,
    workId,
    events,
    connectionState,
    refreshKey,
  )
  const [form, setForm] = useState<InspectorForm>(formRequest?.form ?? null)
  const [reason, setReason] = useState('')
  const [replacement, setReplacement] = useState('')
  const [outcome, setOutcome] = useState<WorkOutcome>('unknown')
  const [sessionId, setSessionId] = useState('')
  const [priority, setPriority] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [opened, setOpened] = useState<string | null>(null)
  useEffect(() => {
    setForm(formRequest?.form ?? null)
    setReason('')
    setError(null)
    setOpened(null)
  }, [workId, formRequest])

  if (!detail) {
    return (
      <aside aria-label={t('kubecode.work.inspector')} className="kubecode-work-inspector">
        <header>
          <IconButton icon={<X aria-hidden size={16} />} label={t('kubecode.work.closeInspector')} onClick={onClose} />
        </header>
        <p className="kubecode-research-muted" role={status === 'error' ? 'alert' : 'status'}>
          {status === 'error' ? t('kubecode.work.loadFailed') : t('kubecode.work.loading')}
        </p>
      </aside>
    )
  }

  const { item } = detail
  const native = detail.operable === 'native' && item.lifecycle === 'active'
  const openAttempt = hasOpenAttempt(detail)
  const run = async (command: WorkCommand) => {
    setBusy(true)
    setError(null)
    try {
      await api.workCommand(projectId, item.id, item.state_revision, command)
      if (command.command === 'start') startKeys.done(detail)
      setForm(null)
      setReason('')
      onChanged()
      reload()
    } catch (cause) {
      setError(workErrorMessage(cause, t))
      if (isStale(cause)) {
        onChanged()
        reload()
      }
    } finally {
      setBusy(false)
    }
  }
  const answer = async (requestId: string, text: string) => {
    setBusy(true)
    setError(null)
    try {
      await api.answerWorkDecision(projectId, item.id, requestId, text)
      setAnswers((current) => ({ ...current, [requestId]: '' }))
      onChanged()
      reload()
    } catch (cause) {
      setError(workErrorMessage(cause, t))
    } finally {
      setBusy(false)
    }
  }
  const staleIds = new Set(detail.stale_evidence.map((entry) => entry.result_id))
  const assignable = sessions.filter((session) => session.id !== detail.executor?.session_id)

  return (
    <aside aria-label={t('kubecode.work.inspector')} className="kubecode-work-inspector">
      <header>
        <div>
          <h3>{item.title}</h3>
          <div className="kubecode-work-card-badges">
            <StatusBadge tone="info">{t(STAGE_LABELS[item.stage])}</StatusBadge>
            {item.condition !== 'none' && (
              <StatusBadge tone="warn">
                {t(CONDITION_LABELS[item.condition])}
              </StatusBadge>
            )}
            {item.lifecycle !== 'active' && (
              <StatusBadge tone="muted">
                {t(LIFECYCLE_LABELS[item.lifecycle as Exclude<WorkLifecycle, 'active'>])}
              </StatusBadge>
            )}
          </div>
        </div>
        <IconButton icon={<X aria-hidden size={16} />} label={t('kubecode.work.closeInspector')} onClick={onClose} />
      </header>

      <dl className="kubecode-work-facts">
        {detail.research && (
          <div>
            <dt>{t('kubecode.work.field.research')}</dt>
            <dd>
              {onOpenResearch ? (
                <Button size="xs" variant="ghost" onClick={() => onOpenResearch(detail.research!.id)}>
                  {detail.research.title}
                </Button>
              ) : detail.research.title}
              {detail.round ? ` · ${t('kubecode.work.roundNumber', { round: detail.round.number })}` : ''}
            </dd>
          </div>
        )}
        {detail.origin_thread && (
          <div>
            <dt>{t('kubecode.work.field.thread')}</dt>
            <dd>
              {onOpenThread ? (
                <Button size="xs" variant="ghost" onClick={() => onOpenThread(detail.origin_thread!.id)}>
                  {detail.origin_thread.title}
                </Button>
              ) : detail.origin_thread.title}
            </dd>
          </div>
        )}
        <div>
          <dt>{t('kubecode.work.field.agent')}</dt>
          <dd>
            {detail.executor ? (
              onOpenSession ? (
                <Button size="xs" variant="ghost" onClick={() => onOpenSession(detail.executor!.session_id)}>
                  {detail.executor.title}
                </Button>
              ) : detail.executor.title
            ) : t('kubecode.work.unassigned')}
          </dd>
        </div>
        {detail.team && (
          <div>
            <dt>{t('kubecode.work.field.team')}</dt>
            <dd>
              {onOpenTeam ? (
                <Button size="xs" variant="ghost" onClick={() => onOpenTeam(detail.team!.id)}>
                  {detail.team.title}
                </Button>
              ) : detail.team.title}
            </dd>
          </div>
        )}
      </dl>

      {item.condition_reason && item.condition !== 'none' && (
        <p className="kubecode-research-notice">{item.condition_reason}</p>
      )}
      {item.stage === 'analyzing' && (
        <p className="kubecode-research-notice" role="status">{t('kubecode.work.analysisWaiting')}</p>
      )}
      {item.closed_reason && (
        <p className="kubecode-research-notice">
          {t('kubecode.work.closedReason', { reason: item.closed_reason })}
        </p>
      )}
      {detail.operable === 'legacy_team' && (
        <p className="kubecode-research-notice" role="status">
          {t('kubecode.work.legacyNotice')}
          {onOpenTeam && detail.team && (
            <>
              {' '}
              <Button size="xs" variant="ghost" onClick={() => onOpenTeam(detail.team!.id)}>
                {t('kubecode.work.openTeam')}
              </Button>
            </>
          )}
        </p>
      )}

      <Section title={t('kubecode.work.field.objective')} text={item.description} />
      <Section title={t('kubecode.work.field.plan')} text={item.plan} />
      <Section title={t('kubecode.work.field.result')} text={item.result} />
      <Section title={t('kubecode.work.field.verification')} text={item.verification} />

      {detail.dependency_states.length > 0 && (
        <section>
          <h4>{t('kubecode.work.field.dependencies')}</h4>
          <ul>
            {detail.dependency_states.map((dependency) => (
              <li key={dependency.id}>
                {dependency.title} · {t(STAGE_LABELS[dependency.stage])}
                {dependency.acceptance === 'accepted' ? ` · ${t('kubecode.work.acceptance.accepted')}` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h4>{t('kubecode.work.field.attempts')}</h4>
        {detail.attempts.length === 0 && <p className="kubecode-research-muted">{t('kubecode.work.noAttempts')}</p>}
        <ol>
          {detail.attempts.map((attempt) => (
            <li key={attempt.id} data-status={attempt.status}>
              {t(`kubecode.work.attemptStatus.${attempt.status}` as 'kubecode.work.attemptStatus.queued')}
              {attempt.error ? ` — ${attempt.error}` : ''}
              <time> {attempt.created_at}</time>
            </li>
          ))}
        </ol>
      </section>

      {detail.experiments.length > 0 && (
        <section>
          <h4>{t('kubecode.work.field.experiments')}</h4>
          <ul>
            {detail.experiments.map((experiment) => {
              const name = experiment.label || experiment.id.slice(0, 8)
              const key = `experiment:${experiment.id}`
              return (
                <li key={experiment.id}>
                  {name} · {experiment.state}
                  {experiment.exit_code != null ? ` · ${t('kubecode.work.exitCode', { code: experiment.exit_code })}` : ''}
                  {experiment.analysis === 'pending' ? ` · ${t('kubecode.work.analysisPending')}` : ''}
                  {' '}
                  <InspectButton
                    label={name}
                    open={opened === key}
                    t={t}
                    onToggle={() => setOpened(opened === key ? null : key)}
                  />
                  {opened === key && (
                    <EvidenceViewer
                      api={api}
                      key={key}
                      projectId={projectId}
                      t={t}
                      target={{ kind: 'experiment', id: experiment.id }}
                    />
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {detail.decisions.length > 0 && (
        <section>
          <h4>{t('kubecode.work.field.decisions')}</h4>
          <ul>
            {detail.decisions.map((decision) => (
              <li key={decision.id}>
                <strong>{t(`kubecode.work.decisionKind.${decision.kind}` as 'kubecode.work.decisionKind.retry')}</strong>
                {` — ${decision.rationale}`}
              </li>
            ))}
          </ul>
        </section>
      )}

      {detail.decision_requests.length > 0 && (
        <section aria-label={t('kubecode.work.field.questions')}>
          <h4>{t('kubecode.work.field.questions')}</h4>
          <ul>
            {detail.decision_requests.map((request) => (
              <li key={request.id} data-state={request.state}>
                <p>{request.question}</p>
                {request.impact && (
                  <small>{t('kubecode.work.question.impact', { impact: request.impact })}</small>
                )}
                {request.state === 'answered' ? (
                  <p className="kubecode-research-muted">
                    {t('kubecode.work.question.answered', { answer: request.answer ?? '' })}
                  </p>
                ) : (
                  <div className="kubecode-work-command-row">
                    {request.options.length > 0 ? (
                      <select
                        aria-label={`${request.question} — ${t('kubecode.work.question.choose')}`}
                        className="kubecode-channel-select"
                        value={answers[request.id] ?? ''}
                        onChange={(event) => setAnswers((current) => ({ ...current, [request.id]: event.target.value }))}
                      >
                        <option value="">{t('kubecode.work.question.choose')}</option>
                        {request.options.map((option) => (
                          <option key={option} value={option}>{option}</option>
                        ))}
                      </select>
                    ) : (
                      <Textarea
                        aria-label={`${request.question} — ${t('kubecode.work.question.placeholder')}`}
                        placeholder={t('kubecode.work.question.placeholder')}
                        rows={2}
                        value={answers[request.id] ?? ''}
                        onChange={(event) => setAnswers((current) => ({ ...current, [request.id]: event.target.value }))}
                      />
                    )}
                    <Button
                      disabled={busy || (answers[request.id] ?? '').trim() === ''}
                      size="sm"
                      onClick={() => void answer(request.id, (answers[request.id] ?? '').trim())}
                    >
                      {t('kubecode.work.question.answer')}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <small className="kubecode-research-muted">{t('kubecode.work.question.note')}</small>
        </section>
      )}

      {detail.results.length > 0 && (
        <section>
          <h4>{t('kubecode.work.field.evidence')}</h4>
          <ul>
            {detail.results.map((result) => (
              <li key={result.id} data-stale={staleIds.has(result.id) || undefined}>
                {result.role} · {result.kind}: {result.ref_id}
                {' '}
                <InspectButton
                  label={result.ref_id}
                  open={opened === `result:${result.id}`}
                  t={t}
                  onToggle={() => setOpened(opened === `result:${result.id}` ? null : `result:${result.id}`)}
                />
                {opened === `result:${result.id}` && (
                  <EvidenceViewer
                    api={api}
                    key={`${result.id}:${result.revision ?? ''}`}
                    projectId={projectId}
                    t={t}
                    target={{ kind: result.kind, id: result.ref_id, revision: result.revision }}
                  />
                )}
                {staleIds.has(result.id) && (
                  <StatusBadge tone="warn">
                    {t(`kubecode.work.stale.${detail.stale_evidence.find((entry) => entry.result_id === result.id)?.status ?? 'changed'}` as 'kubecode.work.stale.changed')}
                  </StatusBadge>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {detail.stale_evidence.length > 0 && (
        <section aria-label={t('kubecode.work.stale.title')}>
          <h4>{t('kubecode.work.stale.title')}</h4>
          <p className="kubecode-research-notice">{t('kubecode.work.stale.hint')}</p>
          {native && detail.stale_evidence.map((entry) => (
            <div className="kubecode-work-command-row" key={entry.result_id}>
              <span>{entry.kind}: {entry.ref_id}</span>
              <Button
                disabled={busy}
                size="sm"
                variant="outline"
                onClick={() => void run({ command: 'repin', result_id: entry.result_id })}
              >
                {t('kubecode.work.command.repin')}
              </Button>
            </div>
          ))}
        </section>
      )}

      {detail.reviews.length > 0 && (
        <section>
          <h4>{t('kubecode.work.field.reviews')}</h4>
          <ul>
            {detail.reviews.map((review) => (
              <li key={review.id}>
                {review.accepted ? t('kubecode.work.acceptance.accepted') : t('kubecode.work.acceptance.rejected')}
                {review.outcome !== 'unknown' ? ` · ${t(`kubecode.work.outcome.${review.outcome}` as 'kubecode.work.outcome.refuted')}` : ''}
                {review.reason ? ` — ${review.reason}` : ''}
                {' '}
                <small>{t('kubecode.work.reviewInputs', { count: review.inputs.length })}</small>
              </li>
            ))}
          </ul>
        </section>
      )}

      {detail.routes.length > 0 && (
        <section>
          <h4>{t('kubecode.work.field.deliveries')}</h4>
          <ul>
            {detail.routes.map((route) => (
              <li key={route.id} data-state={route.state}>
                {route.kind} · {t(`kubecode.work.routeState.${route.state}` as 'kubecode.work.routeState.pending')}
                {route.last_error ? ` — ${route.last_error}` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && <p className="kubecode-research-error" role="alert">{error}</p>}

      {native && (
        <section className="kubecode-work-commands" aria-label={t('kubecode.work.commands')}>
          <div className="kubecode-work-command-row">
            {(item.stage === 'ready' || item.stage === 'executing') && detail.assignment && !openAttempt && (
              <Button
                disabled={busy || detail.executor?.available === false}
                size="sm"
                onClick={() => void run({ command: 'start', request_key: startKeys.keyFor(detail) })}
              >
                {t('kubecode.work.command.start')}
              </Button>
            )}
            {item.condition === 'paused' ? (
              <Button disabled={busy} size="sm" variant="outline" onClick={() => void run({ command: 'resume' })}>
                {t('kubecode.work.command.resume')}
              </Button>
            ) : item.stage !== 'done' && item.condition === 'none' && (
              <Button
                disabled={busy}
                size="sm"
                variant="outline"
                onClick={() => void run({ command: 'pause' })}
              >
                {t('kubecode.work.command.pause')}
              </Button>
            )}
            {item.stage !== 'done' && (
              <Button disabled={busy} size="sm" variant="ghost" onClick={() => setForm('assign')}>
                {t('kubecode.work.command.assign')}
              </Button>
            )}
            <Button disabled={busy} size="sm" variant="ghost" onClick={() => setForm('close')}>
              {t('kubecode.work.command.cancel')}
            </Button>
          </div>

          {form === 'assign' && (
            <div className="kubecode-work-command-row">
              <select
                aria-label={t('kubecode.work.command.chooseSession')}
                className="kubecode-channel-select"
                value={sessionId}
                onChange={(event) => setSessionId(event.target.value)}
              >
                <option value="">{t('kubecode.work.command.chooseSession')}</option>
                {assignable.map((session) => (
                  <option key={session.id} value={session.id}>{session.title}</option>
                ))}
              </select>
              <Button
                disabled={busy || sessionId === ''}
                size="sm"
                onClick={() => void run({ command: 'assign', session_id: sessionId })}
              >
                {t('kubecode.work.command.assign')}
              </Button>
            </div>
          )}

          {item.stage === 'review' && (
            <div className="kubecode-work-review">
              <label>
                <span>{t('kubecode.work.review.outcome')}</span>
                <select
                  className="kubecode-channel-select"
                  value={outcome}
                  onChange={(event) => setOutcome(event.target.value as WorkOutcome)}
                >
                  {OUTCOMES.map((value) => (
                    <option key={value} value={value}>
                      {t(`kubecode.work.outcome.${value}` as 'kubecode.work.outcome.refuted')}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{t('kubecode.work.review.reason')}</span>
                <Textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
              </label>
              <div className="kubecode-work-command-row">
                {form !== 'reject' && (
                  <Button
                    disabled={busy}
                    size="sm"
                    onClick={() => void run({
                      command: 'review', accept: true, outcome, reason: reason.trim() || undefined,
                    })}
                  >
                    {t('kubecode.work.command.accept')}
                  </Button>
                )}
                {form !== 'accept' && (
                  <Button
                    disabled={busy}
                    size="sm"
                    variant="outline"
                    onClick={() => void run({
                      command: 'review', accept: false, reason: reason.trim() || undefined,
                    })}
                  >
                    {t('kubecode.work.command.reject')}
                  </Button>
                )}
              </div>
            </div>
          )}

          {form === 'close' && (
            <div className="kubecode-work-review">
              <label>
                <span>{t('kubecode.work.review.reason')}</span>
                <Textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
              </label>
              <div className="kubecode-work-command-row">
                {(['canceled', 'abandoned'] as const).map((lifecycle) => (
                  <Button
                    disabled={busy || reason.trim() === ''}
                    key={lifecycle}
                    size="sm"
                    variant="outline"
                    onClick={() => void run({
                      command: 'close', lifecycle, reason: reason.trim(), expected_revision: item.revision,
                    })}
                  >
                    {t(LIFECYCLE_LABELS[lifecycle])}
                  </Button>
                ))}
              </div>
              {replacements.length > 0 && (
                <div className="kubecode-work-command-row">
                  <select
                    aria-label={t('kubecode.work.command.chooseReplacement')}
                    className="kubecode-channel-select"
                    value={replacement}
                    onChange={(event) => setReplacement(event.target.value)}
                  >
                    <option value="">{t('kubecode.work.command.chooseReplacement')}</option>
                    {replacements.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>{candidate.title}</option>
                    ))}
                  </select>
                  <Button
                    disabled={busy || reason.trim() === '' || replacement === ''}
                    size="sm"
                    variant="outline"
                    onClick={() => void run({
                      command: 'close',
                      lifecycle: 'superseded',
                      reason: reason.trim(),
                      expected_revision: item.revision,
                      superseded_by: replacement,
                    })}
                  >
                    {t(LIFECYCLE_LABELS.superseded)}
                  </Button>
                </div>
              )}
            </div>
          )}

          <div className="kubecode-work-command-row">
            <label>
              <span>{t('kubecode.work.field.priority')}</span>
              <input
                aria-label={t('kubecode.work.field.priority')}
                className="kubecode-channel-select"
                inputMode="numeric"
                placeholder={String(item.priority)}
                value={priority}
                onChange={(event) => setPriority(event.target.value)}
              />
            </label>
            <Button
              disabled={busy || !/^-?\d{1,6}$/.test(priority)}
              size="sm"
              variant="outline"
              onClick={() => void run({
                command: 'prioritize', priority: Number(priority), expected_revision: item.revision,
              })}
            >
              {t('kubecode.work.command.prioritize')}
            </Button>
          </div>
        </section>
      )}
    </aside>
  )
}

function InspectButton({
  label, onToggle, open, t,
}: { label: string; onToggle: () => void; open: boolean; t: Translator }) {
  return (
    <Button
      aria-expanded={open}
      aria-label={`${open ? t('kubecode.work.evidence.hide') : t('kubecode.work.evidence.view')}: ${label}`}
      size="xs"
      variant="ghost"
      onClick={onToggle}
    >
      {open ? t('kubecode.work.evidence.hide') : t('kubecode.work.evidence.view')}
    </Button>
  )
}

function Section({ text, title }: { text: string | null; title: string }) {
  if (!text) return null
  return (
    <section>
      <h4>{title}</h4>
      <p className="kubecode-work-text">{text}</p>
    </section>
  )
}

