import { useEffect, useId, useRef, useState } from 'react'
import { CircleAlert, TriangleAlert } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription } from '@/components/ui/empty'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Item, ItemGroup, ItemTitle } from '@/components/ui/item'
import { Spinner } from '@/components/ui/spinner'
import { StatusBadge } from '@/components/workspace/StatusBadge'
import type { Translator } from '@/lib/i18n'

import { ApiError } from '../api'
import type {
  ExecutionEnvelope,
  ExperimentDecision,
  ExperimentDecisionKind,
  ExperimentLogTail,
  ExperimentState,
  ExperimentView,
  ExperimentWait,
  KubecodeApi,
  LaunchBlocker,
  ResearchRound,
  TeamSnapshot,
  WorkspaceEvent,
} from '../api'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'
import { ExecutionEnvelopeFields } from './ExecutionEnvelopeFields'
import { draftFromLimits, limitsFromDraft, type EnvelopeDraft } from './executionEnvelope'
import { AvailabilityBadge } from './SourceBadge'
import { useAction } from './useAction'
import { useResearchExecution } from './useResearch'
import { ReaderLoading, ReaderNotice } from '../resources/ReaderStates'

const STATE_LABELS: Record<ExperimentState, Parameters<Translator>[0]> = {
  reserved: 'kubecode.research.exec.state.reserved',
  launching: 'kubecode.research.exec.state.launching',
  running: 'kubecode.research.exec.state.running',
  cancelling: 'kubecode.research.exec.state.cancelling',
  exited: 'kubecode.research.exec.state.exited',
  timed_out: 'kubecode.research.exec.state.timedOut',
  cancelled: 'kubecode.research.exec.state.cancelled',
  failed_to_start: 'kubecode.research.exec.state.failedToStart',
  unknown: 'kubecode.research.exec.state.unknown',
}

const DECISION_LABELS: Record<ExperimentDecisionKind, Parameters<Translator>[0]> = {
  further_analysis: 'kubecode.research.exec.decision.furtherAnalysis',
  repair: 'kubecode.research.exec.decision.repair',
  retry: 'kubecode.research.exec.decision.retry',
  follow_up: 'kubecode.research.exec.decision.followUp',
  external_wait: 'kubecode.research.exec.decision.externalWait',
  researcher_input: 'kubecode.research.exec.decision.researcherInput',
  conclude: 'kubecode.research.exec.decision.conclude',
}

const BLOCKER_LABELS: Record<LaunchBlocker, Parameters<Translator>[0]> = {
  no_envelope: 'kubecode.research.exec.blocker.noEnvelope',
  envelope_paused: 'kubecode.research.exec.blocker.paused',
  envelope_closed: 'kubecode.research.exec.blocker.closed',
  deadline_passed: 'kubecode.research.exec.blocker.deadline',
  command_not_authorized: 'kubecode.research.exec.blocker.command',
  launch_budget_exhausted: 'kubecode.research.exec.blocker.budget',
  concurrency_limit: 'kubecode.research.exec.blocker.concurrency',
  no_progress: 'kubecode.research.exec.blocker.noProgress',
  team_not_active: 'kubecode.research.exec.blocker.team',
}

function formatUnix(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString()
}

function commandText(argv: string[]): string {
  return argv.map((token) => (/\s/.test(token) ? `"${token}"` : token)).join(' ')
}

/** Experiments whose process may still be running or whose fate is unrecorded. */
function isActive(state: ExperimentState): boolean {
  return ['reserved', 'launching', 'running', 'cancelling', 'unknown'].includes(state)
}

export type ResearchExecutionSectionProps = {
  api: KubecodeApi
  archived: boolean
  connectionState: WorkspaceConnectionState
  events: WorkspaceEvent[]
  projectId: string
  researchId: string
  round: ResearchRound
  t: Translator
  teams: TeamSnapshot[]
}

/**
 * What is running, what the Team is waiting for, what it decided, and what the
 * researcher can do about it — for one round. A turn ending is never shown as
 * an experiment being analyzed: analysis is its own state.
 */
export function ResearchExecutionSection({
  api,
  archived,
  connectionState,
  events,
  projectId,
  researchId,
  round,
  t,
  teams,
}: ResearchExecutionSectionProps) {
  const { execution, reload, serverNow, status } = useResearchExecution(
    api,
    projectId,
    researchId,
    round.id,
    events,
    connectionState,
  )
  // The draft and the revision it was built from, captured when editing began.
  const [editing, setEditing] = useState<{ draft: EnvelopeDraft; revision: number } | null>(null)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const control = useAction(t)

  if (!execution) {
    return (
      <div className={EXECUTION} aria-busy={status === 'loading'}>
        {status === 'loading' && <ReaderLoading>{t('kubecode.research.exec.loading')}</ReaderLoading>}
        {status === 'error' && (
          <ReaderNotice action={<Button size="xs" variant="outline" onClick={reload}>{t('kubecode.retry')}</Button>} failed>
            {t('kubecode.research.exec.loadFailed')}
          </ReaderNotice>
        )}
      </div>
    )
  }

  const { envelope } = execution
  // Only finished results can await analysis; a running process has none yet.
  const owed = execution.experiments.filter(
    (experiment) => !isActive(experiment.state) && experiment.analysis === 'pending',
  )
  const active = execution.experiments.filter((experiment) => isActive(experiment.state))
  const memberName = (wait: ExperimentWait) => teams
    .find((snapshot) => snapshot.team.id === wait.team_id)
    ?.members.find((member) => member.id === wait.owner_member_id)?.name ?? wait.owner_member_id
  const done = async () => {
    reload()
  }

  return (
    <div className={EXECUTION}>
      <header className="flex flex-wrap items-center gap-2">
        <h4 className="m-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('kubecode.research.exec.title')}</h4>
        {envelope && (
          <>
            <StatusBadge tone={envelope.state === 'active' ? 'ok' : 'warn'}>
              {t(`kubecode.research.exec.envelopeState.${envelope.state}` as Parameters<Translator>[0])}
            </StatusBadge>
            <span className="text-xs text-muted-foreground">
              {t('kubecode.research.exec.policyRevision', { revision: envelope.revision })}
            </span>
          </>
        )}
      </header>
      {status === 'error' && (
        <Alert role="status"><TriangleAlert /><AlertDescription>{t('kubecode.research.exec.stale')}</AlertDescription></Alert>
      )}

      {execution.launch_blockers.length > 0 && envelope && (
        <Alert role="note">
          <TriangleAlert />
          <AlertDescription>
            <ul className="m-0 list-disc pl-5" aria-label={t('kubecode.research.exec.attention')}>
              {execution.launch_blockers
                .filter((blocker) => blocker !== 'no_envelope')
                .map((blocker) => (
                  <li key={blocker}>{t(BLOCKER_LABELS[blocker])}</li>
                ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {owed.length > 0 && (
        <Alert role="status">
          <CircleAlert />
          <AlertDescription>{t('kubecode.research.exec.owed', { count: owed.length })}</AlertDescription>
        </Alert>
      )}

      {!envelope ? (
        <>
          <p className="m-0 text-sm text-muted-foreground">{t('kubecode.research.exec.noEnvelope')}</p>
          {!archived && (
            <EnvelopeEditor
              api={api}
              baseRevision={null}
              now={serverNow}
              onConflict={reload}
              onSaved={done}
              projectId={projectId}
              researchId={researchId}
              roundId={round.id}
              t={t}
            />
          )}
        </>
      ) : (
        <>
          <EnvelopeSummary envelope={envelope} active={active.length} now={execution.now} t={t} />
          <div className="flex flex-wrap items-center gap-2">
            {envelope.state === 'active' && (
              <Button
                disabled={control.busy}
                size="xs"
                variant="outline"
                onClick={() => void control.run(async () => {
                  await api.setResearchExecutionState(projectId, researchId, round.id, 'pause')
                  reload()
                })}
              >
                {t('kubecode.execution.pauseLaunches', { round: round.round })}
              </Button>
            )}
            {envelope.state === 'paused' && (
              <Button
                disabled={control.busy}
                size="xs"
                variant="outline"
                onClick={() => void control.run(async () => {
                  await api.setResearchExecutionState(projectId, researchId, round.id, 'resume')
                  reload()
                })}
              >
                {t('kubecode.execution.resumeLaunches', { round: round.round })}
              </Button>
            )}
            {envelope.state !== 'closed' && !archived && editing === null && (
              <Button
                size="xs"
                variant="outline"
                onClick={() => setEditing({
                  draft: draftFromLimits(envelope.limits, serverNow()),
                  revision: envelope.revision,
                })}
              >
                {t('kubecode.research.exec.editEnvelope')}
              </Button>
            )}
            {envelope.state !== 'closed' && (
              <Button size="xs" variant="ghost" onClick={() => setConfirmCancel(true)}>
                {t('kubecode.research.exec.cancelAll')}
              </Button>
            )}
          </div>
          {envelope.state === 'active' && (
            <p className="m-0 text-xs text-muted-foreground">{t('kubecode.research.exec.pauseHint')}</p>
          )}
          <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('kubecode.research.exec.cancelAll')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t('kubecode.research.exec.cancelAllConfirm', { count: active.length })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('kubecode.research.exec.keepRunning')}</AlertDialogCancel>
                {/* Not AlertDialogAction: the dialog stays until the server accepts the cancel. */}
                <Button
                  aria-busy={control.busy}
                  disabled={control.busy}
                  variant="destructive"
                  onClick={() => void control.run(async () => {
                    await api.cancelResearchExecution(projectId, researchId, round.id)
                    setConfirmCancel(false)
                    reload()
                  })}
                >
                  {control.busy && <Spinner data-icon="inline-start" />}
                  {t('kubecode.research.exec.cancelAllYes')}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          {editing && (
            <EnvelopeEditor
              api={api}
              baseRevision={editing.revision}
              initial={editing.draft}
              now={serverNow}
              onConflict={reload}
              onCancel={() => setEditing(null)}
              onSaved={async () => {
                setEditing(null)
                reload()
              }}
              projectId={projectId}
              researchId={researchId}
              roundId={round.id}
              t={t}
            />
          )}
        </>
      )}
      {control.error && <Alert variant="destructive"><AlertDescription>{control.error}</AlertDescription></Alert>}

      {execution.experiments.length === 0 && envelope && (
        <Empty className="items-start p-0 text-left md:p-0">
          <EmptyDescription>{t('kubecode.research.exec.noExperiments')}</EmptyDescription>
        </Empty>
      )}
      <ItemGroup className="gap-2 empty:hidden">
        {execution.experiments.map((experiment) => (
          <ExperimentCard
            api={api}
            decisions={execution.decisions.filter((decision) => decision.experiment_id === experiment.id)}
            experiment={experiment}
            key={experiment.id}
            memberName={memberName}
            onChanged={reload}
            projectId={projectId}
            researchId={researchId}
            t={t}
            waits={execution.waits.filter((wait) => wait.experiment_id === experiment.id)}
          />
        ))}
      </ItemGroup>
    </div>
  )
}

function EnvelopeSummary({
  active,
  envelope,
  now,
  t,
}: {
  active: number
  envelope: ExecutionEnvelope
  now: number
  t: Translator
}) {
  const { limits } = envelope
  return (
    <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-x-4 gap-y-2 text-sm">
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">{t('kubecode.research.exec.launches')}</dt>
        <dd className="m-0 [overflow-wrap:anywhere]">{envelope.launches_reserved} / {limits.max_launches}</dd>
      </div>
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">{t('kubecode.research.exec.processes')}</dt>
        <dd className="m-0 [overflow-wrap:anywhere]">{active} / {limits.max_concurrent}</dd>
      </div>
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">{t('kubecode.research.exec.runtimeCap')}</dt>
        <dd className="m-0 [overflow-wrap:anywhere]">{t('kubecode.research.exec.minutes', { count: Math.round(limits.max_runtime_secs / 60) })}</dd>
      </div>
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">{t('kubecode.research.exec.deadline')}</dt>
        <dd className="m-0 [overflow-wrap:anywhere]">
          {limits.deadline_at === null
            ? t('kubecode.research.exec.noDeadline')
            : limits.deadline_at <= now
              ? t('kubecode.research.exec.deadlinePassed', { time: formatUnix(limits.deadline_at) })
              : formatUnix(limits.deadline_at)}
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">{t('kubecode.research.exec.allowedCommands')}</dt>
        <dd className="m-0 [overflow-wrap:anywhere]">
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {limits.allowed_commands.map((command) => (
              <li key={command.join('\u0000')}><code>{commandText(command)}</code></li>
            ))}
          </ul>
        </dd>
      </div>
    </dl>
  )
}

function EnvelopeEditor({
  api,
  baseRevision,
  initial,
  now,
  onCancel,
  onConflict,
  onSaved,
  projectId,
  researchId,
  roundId,
  t,
}: {
  api: KubecodeApi
  /** The envelope revision the draft was built from; null when creating. */
  baseRevision: number | null
  initial?: EnvelopeDraft
  /** Server time, read when saving so a long-open editor never uses a stale clock. */
  now: () => number
  onCancel?: () => void
  onConflict: () => void
  onSaved: () => Promise<void>
  projectId: string
  researchId: string
  roundId: string
  t: Translator
}) {
  const [draft, setDraft] = useState<EnvelopeDraft | null>(initial ?? null)
  const [invalid, setInvalid] = useState<Parameters<typeof ExecutionEnvelopeFields>[0]['invalid']>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const action = useAction(t, (cause) => {
    if (cause instanceof ApiError && cause.code === 'envelope_revision_conflict') onConflict()
  })
  const open = draft !== null
  useEffect(() => {
    if (open) formRef.current?.querySelector('input')?.focus()
  }, [open])

  if (!draft) {
    return (
      <Button
        size="sm"
        variant="outline"
        onClick={() => setDraft(initial ?? {
          maxLaunches: '5', maxConcurrent: '1', maxRuntimeMinutes: '30', deadlineHours: '',
          maxNoProgress: '3', commands: '', existingDeadline: null, deadlineEdited: false,
          existingCommands: null, existingCommandsText: '',
        })}
      >
        {t('kubecode.research.exec.setUp')}
      </Button>
    )
  }
  const save = async () => {
    const result = limitsFromDraft(draft, now())
    if (!result.ok) {
      setInvalid(result.field)
      return
    }
    setInvalid(null)
    const saved = await action.run(() => api.setResearchEnvelope(
      projectId,
      researchId,
      roundId,
      result.limits,
      baseRevision ?? undefined,
    ))
    if (saved) await onSaved()
  }
  return (
    <form
      className="flex flex-col gap-2"
      ref={formRef}
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <ExecutionEnvelopeFields draft={draft} invalid={invalid} onChange={setDraft} t={t} />
      {baseRevision !== null && <p className="m-0 text-xs text-muted-foreground">{t('kubecode.research.exec.runningKeepsRevision')}</p>}
      {action.error && <Alert variant="destructive"><AlertDescription>{action.error}</AlertDescription></Alert>}
      <div className="flex flex-wrap justify-end gap-2">
        {(onCancel || baseRevision === null) && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setDraft(null)
              onCancel?.()
            }}
          >
            {t('kubecode.cancel')}
          </Button>
        )}
        <Button aria-busy={action.busy} disabled={action.busy} size="sm" type="submit">
          {t('kubecode.research.exec.saveEnvelope')}
        </Button>
      </div>
    </form>
  )
}

function ExperimentCard({
  api,
  decisions,
  experiment,
  memberName,
  onChanged,
  projectId,
  researchId,
  t,
  waits,
}: {
  api: KubecodeApi
  decisions: ExperimentDecision[]
  experiment: ExperimentView
  memberName: (wait: ExperimentWait) => string
  onChanged: () => void
  projectId: string
  researchId: string
  t: Translator
  waits: ExperimentWait[]
}) {
  const [logs, setLogs] = useState<{ stdout: ExperimentLogTail; stderr: ExperimentLogTail } | null>(null)
  const [exitCode, setExitCode] = useState('')
  const action = useAction(t)
  const fieldId = useId()
  const title = experiment.label || commandText(experiment.argv)
  const openWait = waits.find((wait) => wait.state === 'open')

  const loadLogs = () => void action.run(async () => {
    const [stdout, stderr] = await Promise.all([
      api.getExperimentLog(projectId, researchId, experiment.id, 'stdout'),
      api.getExperimentLog(projectId, researchId, experiment.id, 'stderr'),
    ])
    setLogs({ stdout, stderr })
  })
  const [exitCodeInvalid, setExitCodeInvalid] = useState(false)
  const reconcile = (truth: 'not_started' | 'finished') => {
    // An exit code only means something for a process that finished.
    let parsed: number | undefined
    if (truth === 'finished' && exitCode.trim() !== '') {
      const value = Number(exitCode)
      if (!/^-?\d+$/.test(exitCode.trim()) || !Number.isSafeInteger(value) || Math.abs(value) > 2_147_483_647) {
        setExitCodeInvalid(true)
        return
      }
      parsed = value
    }
    setExitCodeInvalid(false)
    void action.run(async () => {
      await api.reconcileExperiment(projectId, researchId, experiment.id, truth, parsed)
      onChanged()
    })
  }

  return (
    <Item className="flex-col items-stretch gap-2" data-state={experiment.state} role="listitem" size="sm" variant="outline">
      <div className="flex flex-wrap items-center gap-2">
        <ItemTitle className="[overflow-wrap:anywhere]">{title}</ItemTitle>
        <StatusBadge tone={experiment.state === 'unknown' ? 'warn' : experiment.state === 'running' ? 'ok' : 'muted'}>
          {t(STATE_LABELS[experiment.state])}
        </StatusBadge>
        {(experiment.analysis !== 'none' || isActive(experiment.state)) && (
          <StatusBadge tone={experiment.analysis === 'pending' ? 'warn' : 'muted'}>
            {experiment.analysis === 'pending'
              ? t('kubecode.research.exec.awaitingAnalysis')
              : experiment.analysis === 'analyzed'
                ? t('kubecode.research.exec.analyzed')
                : t('kubecode.research.exec.notYetAnalyzable')}
          </StatusBadge>
        )}
        <span className="text-xs text-muted-foreground">
          {t('kubecode.research.exec.policyRevision', { revision: experiment.policy_revision })}
        </span>
      </div>
      {experiment.label && <code className="text-xs [overflow-wrap:anywhere]">{commandText(experiment.argv)}</code>}
      <span className="text-xs text-muted-foreground empty:hidden">
        {experiment.exit_code !== null && t('kubecode.research.exec.exitCode', { code: experiment.exit_code })}
        {experiment.signal !== null && ` · ${t('kubecode.research.exec.signal', { signal: experiment.signal })}`}
        {experiment.reason ? ` · ${experiment.reason}` : ''}
      </span>
      {experiment.state === 'unknown' && (
        <Alert aria-label={`${t('kubecode.research.exec.reconcile')}: ${title}`} role="group">
          <TriangleAlert />
          <AlertDescription className="gap-2">
          <p>{t('kubecode.research.exec.unknownHint')}</p>
          <Field data-invalid={exitCodeInvalid || undefined}>
            <FieldLabel htmlFor={`${fieldId}-exit-code`}>{t('kubecode.research.exec.exitCodeOptional')}</FieldLabel>
            <Input
              aria-invalid={exitCodeInvalid}
              id={`${fieldId}-exit-code`}
              inputMode="numeric"
              value={exitCode}
              onChange={(event) => setExitCode(event.target.value)}
            />
            {exitCodeInvalid && (
              <FieldError role="alert">{t('kubecode.research.exec.invalidExitCode')}</FieldError>
            )}
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              aria-label={`${t('kubecode.research.exec.neverStarted')}: ${title}`}
              disabled={action.busy}
              size="xs"
              variant="outline"
              onClick={() => reconcile('not_started')}
            >
              {t('kubecode.research.exec.neverStarted')}
            </Button>
            <Button
              aria-label={`${t('kubecode.research.exec.didFinish')}: ${title}`}
              disabled={action.busy}
              size="xs"
              variant="outline"
              onClick={() => reconcile('finished')}
            >
              {t('kubecode.research.exec.didFinish')}
            </Button>
          </div>
          </AlertDescription>
        </Alert>
      )}
      {openWait && (
        <p className="m-0 text-xs text-muted-foreground">
          {t('kubecode.research.exec.waiting', {
            member: memberName(openWait),
            until: openWait.deadline_at === null ? '—' : formatUnix(openWait.deadline_at),
          })}
          {openWait.expected_follow_up ? ` · ${openWait.expected_follow_up}` : ''}
        </p>
      )}
      {experiment.artifact_state.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-xs" aria-label={t('kubecode.research.exec.artifacts')}>
          {experiment.artifact_state.map((artifact) => (
            <li className="flex flex-wrap items-center gap-1.5" key={artifact.path}>
              <code className="[overflow-wrap:anywhere]">{artifact.path}</code>
              <AvailabilityBadge availability={artifact.availability} t={t} />
            </li>
          ))}
        </ul>
      )}
      {decisions.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm" aria-label={t('kubecode.research.exec.decisions')}>
          {decisions.map((decision) => (
            <li className="[overflow-wrap:anywhere]" key={decision.id}>
              <StatusBadge tone="ok">{t(DECISION_LABELS[decision.kind])}</StatusBadge>{' '}
              {decision.rationale}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          aria-label={`${logs ? t('kubecode.research.exec.refreshOutput') : t('kubecode.research.exec.viewOutput')}: ${title}`}
          disabled={action.busy}
          size="xs"
          variant="outline"
          onClick={loadLogs}
        >
          {logs ? t('kubecode.research.exec.refreshOutput') : t('kubecode.research.exec.viewOutput')}
        </Button>
        {isActive(experiment.state) && experiment.state !== 'unknown' && !experiment.cancel_requested && (
          <Button
            disabled={action.busy}
            size="xs"
            variant="ghost"
            aria-label={`${t('kubecode.research.exec.stop')}: ${title}`}
            onClick={() => void action.run(async () => {
              await api.cancelExperiment(projectId, researchId, experiment.id)
              onChanged()
            })}
          >
            {t('kubecode.research.exec.stop')}
          </Button>
        )}
      </div>
      {logs && (
        <div className="flex flex-col gap-2">
          {(['stdout', 'stderr'] as const).map((stream) => (
            <section className="flex min-w-0 flex-col gap-1" key={stream} aria-label={t(`kubecode.research.exec.${stream}` as Parameters<Translator>[0])}>
              <h5 className="m-0 text-xs font-semibold text-muted-foreground">{t(`kubecode.research.exec.${stream}` as Parameters<Translator>[0])}</h5>
              <pre className="m-0 max-h-60 overflow-auto rounded-md border bg-muted p-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]" tabIndex={0}>{logs[stream].text || t('kubecode.research.exec.emptyOutput')}</pre>
              {logs[stream].truncated && (
                <span className="text-xs text-muted-foreground">
                  {t('kubecode.research.exec.truncated', { bytes: logs[stream].total_bytes })}
                </span>
              )}
            </section>
          ))}
        </div>
      )}
      {action.error && <Alert variant="destructive"><AlertDescription>{action.error}</AlertDescription></Alert>}
    </Item>
  )
}

const EXECUTION = 'mt-1 flex flex-col gap-2 border-t pt-2'
