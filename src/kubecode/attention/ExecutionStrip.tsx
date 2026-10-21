import { useContext, useEffect, useRef, useState } from 'react'

import { Shimmer } from '@/components/ai-elements'
import { Button } from '@/components/ui/button'
import { MemberIdentity } from '@/components/workspace/MemberIdentity'
import { StopButton } from '@/components/workspace/SendButton'
import type { Translator } from '@/lib/i18n'

import type { AgentEvent, AttentionItem, ExecutionFailure, ExecutionView, KubecodeApi } from '../api'
import { placeKey, usePlaceState } from '../app/location/placeMemory'
import { WorkspaceNavigationContext } from '../app/location/WorkspaceNavigation'
import { elicitationFromEvent, type ElicitationAnswer } from '../session/conversationReducer'
import { elicitationContent, initialElicitationAnswers } from '../session/sessionModel'
import { askerName } from './attentionTargets'
import { useAttention, type ExecutionScope } from './attentionContext'
import { ElicitationPrompt } from './ElicitationPrompt'
import { PermissionPrompt } from './PermissionPrompt'

const QUIET_ROWS = 2
const STOP_FALLBACK_MS = 15_000

export type ExecutionStripProps = {
  api: KubecodeApi
  scope: ExecutionScope
  t: Translator
  /** Prompts appear only in General or the DM; a Task's strip lists the work and its Stop. */
  prompts?: boolean
}

type Kinded<K extends AttentionItem['kind']> = Extract<AttentionItem, { kind: K }>

function inScope(scope: ExecutionScope, item: AttentionItem): boolean {
  if (item.kind !== 'permission' && item.kind !== 'input') return false
  if ('taskId' in scope) return item.task?.id === scope.taskId
  if (scope.binding === 'public') return item.binding === 'public'
  return item.binding === 'dm' && item.member?.id === scope.memberId
}

function nameOf(run: Pick<ExecutionView, 'member' | 'session_title'>, t: Translator): string {
  return askerName(run, t)
}

/** The prompt heading: who asks, and for which Task. */
function heading(item: AttentionItem, key: 'kubecode.attention.permissionFrom' | 'kubecode.attention.inputFrom', t: Translator) {
  const who = t(key, { name: askerName(item, t) })
  return item.task ? `${who} · ${t('kubecode.attention.forTask', { task: item.task.title })}` : who
}

function PermissionRow({ api, item, t }: { api: KubecodeApi; item: Kinded<'permission'>; t: Translator }) {
  const attention = useAttention()
  // The server says how long is left; the deadline is fixed when the request is first shown.
  const [deadline] = useState(() => (item.deadline_ms === null ? null : Date.now() + item.deadline_ms))
  return (
    <PermissionPrompt
      deadlineMs={deadline}
      heading={heading(item, 'kubecode.attention.permissionFrom', t)}
      options={item.options}
      requestId={item.request_id}
      t={t}
      tool={item.tool}
      resolving={attention?.resolving.has(item.key) ?? false}
      onGone={() => attention?.reload()}
      onResolve={(optionId) => (attention
        ? attention.markResolving(item.key, () => api.resolvePermission(item.request_id, optionId))
        : api.resolvePermission(item.request_id, optionId))}
    />
  )
}

function InputRow({ api, item, t }: { api: KubecodeApi; item: Kinded<'input'>; t: Translator }) {
  const attention = useAttention()
  const [elicitation] = useState(() => elicitationFromEvent({
    payload: { request_id: item.request_id, message: item.message, requestedSchema: item.schema },
  } as unknown as AgentEvent))
  const [answers, setAnswers] = useState<Record<string, ElicitationAnswer>>(() => initialElicitationAnswers(elicitation))
  if (!elicitation) return null
  const resolve = (accepted: boolean) => {
    const call = () => api.resolveElicitation(item.request_id, accepted ? elicitationContent(elicitation, answers) : null)
    return attention ? attention.markResolving(item.key, call) : call()
  }
  return (
    <ElicitationPrompt
      answers={answers}
      elicitation={elicitation}
      heading={heading(item, 'kubecode.attention.inputFrom', t)}
      resolving={attention?.resolving.has(item.key) ?? false}
      t={t}
      onAnswerChange={(id, value) => setAnswers((current) => ({ ...current, [id]: value }))}
      onGone={() => attention?.reload()}
      onResolve={resolve}
    />
  )
}

function stateText(run: ExecutionView, t: Translator): string {
  const name = nameOf(run, t)
  if (run.waiting_keys.length > 0) return t('kubecode.execution.waitingPermission', { name })
  // Waiting with nothing the researcher can answer: a Team leader reviews it first.
  if (run.status === 'waiting_permission') return t('kubecode.execution.waitingLeader', { name })
  return run.tasks[0]
    ? t('kubecode.execution.workingOn', { name, task: run.tasks.map((task) => task.title).join(', ') })
    : t('kubecode.execution.working', { name })
}

function RunRow({ dm, onStop, run, stopping, t }: {
  dm: boolean
  onStop: () => void
  run: ExecutionView
  stopping: boolean
  t: Translator
}) {
  const name = nameOf(run, t)
  return (
    <li className="kubecode-execution-row" data-run-id={run.run_id}>
      {run.member
        ? <MemberIdentity handle={run.member.handle} name={run.member.name} role={run.member.role === 'general' ? 'manager' : 'specialist'} size="sm" />
        : <strong>{name}</strong>}
      <span className="kubecode-execution-state">
        {/* Work still under way shimmers; a wait on the researcher is said plainly. */}
        {run.waiting_keys.length > 0 || run.status === 'waiting_permission'
          ? stateText(run, t)
          : <Shimmer>{stateText(run, t)}</Shimmer>}
        {run.queued > 0 && <> · {t('kubecode.execution.queued', { count: run.queued, plural: run.queued === 1 ? '' : 's' })}</>}
        {stopping && <> · {t('kubecode.execution.stopping')}</>}
      </span>
      <StopButton
        busy={stopping}
        description={t('kubecode.execution.stopHint', { name })}
        label={t(dm ? 'kubecode.execution.stopReply' : 'kubecode.execution.stopTurn', { name })}
        shortLabel={t('kubecode.execution.stopShort')}
        onStop={onStop}
      />
    </li>
  )
}

function FailureRow({ failure, onDismiss, t }: { failure: ExecutionFailure; onDismiss: () => void; t: Translator }) {
  const navigation = useContext(WorkspaceNavigationContext)
  const key = failure.status === 'interrupted' ? 'kubecode.execution.turnInterrupted' : 'kubecode.execution.turnFailed'
  return (
    <li className="kubecode-execution-row" data-state="failed">
      <span className="kubecode-execution-state kubecode-research-error">{t(key, { name: failure.member.name })}</span>
      {/* The member's profile holds what fixes a failing turn: its Session, its setup. */}
      {navigation && (
        <Button
          size="xs"
          variant="outline"
          onClick={() => navigation.openPlace({ view: 'members' }, { inspect: { kind: 'member', id: failure.member.id } })}
        >
          {t('kubecode.execution.openMember', { name: failure.member.name })}
        </Button>
      )}
      <Button size="xs" variant="ghost" onClick={onDismiss}>{t('kubecode.execution.dismiss')}</Button>
    </li>
  )
}

/**
 * Who is working now (ADR 0232): one row per member turn, with what it works
 * on, what is queued, and a Stop that names whose turn it ends; the
 * permission or input a member waits on, answered in place; and a member's
 * last failed turn, once, until dismissed. Nothing is posted to General.
 */
export function ExecutionStrip({ api, prompts = true, scope, t }: ExecutionStripProps) {
  const attention = useAttention()
  const runs = attention?.executions(scope) ?? []
  const items = prompts ? attention?.snapshot?.items.filter((item) => inScope(scope, item)) ?? [] : []
  const projectId = attention?.projectId ?? null
  const [dismissed, setDismissed] = usePlaceState<string[]>(
    projectId ? `${placeKey.view(projectId, 'general')}#dismissedFailures` : null,
    [],
  )
  const failures = (attention?.failures(scope) ?? []).filter((entry) => !dismissed.includes(entry.run_id))
  const dm = 'binding' in scope && scope.binding === 'dm'

  // A stop is busy until its run leaves the snapshot; then it is announced.
  const [stopping, setStopping] = useState<ReadonlyMap<string, string>>(new Map())
  const [announcement, setAnnouncement] = useState('')
  const running = new Set(runs.map((run) => run.run_id))
  const stopped = [...stopping].filter(([runId]) => !running.has(runId))
  if (stopped.length > 0) {
    const next = new Map(stopping)
    stopped.forEach(([runId]) => next.delete(runId))
    setStopping(next)
    setAnnouncement(t('kubecode.execution.stopped', { name: stopped[0][1] }))
  }
  const timers = useRef(new Set<number>())
  useEffect(() => {
    const pending = timers.current
    return () => pending.forEach((timer) => window.clearTimeout(timer))
  }, [])
  const stop = (run: ExecutionView) => {
    if (stopping.has(run.run_id)) return
    const name = nameOf(run, t)
    setStopping((current) => new Map(current).set(run.run_id, name))
    api.cancelRun(run.run_id).then(() => {
      attention?.reload()
      const timer = window.setTimeout(() => {
        timers.current.delete(timer)
        attention?.reload()
      }, STOP_FALLBACK_MS)
      timers.current.add(timer)
    }, () => {
      setStopping((current) => {
        const next = new Map(current)
        next.delete(run.run_id)
        return next
      })
      setAnnouncement(t('kubecode.execution.stopFailed', { name }))
    })
  }

  if (runs.length === 0 && items.length === 0 && failures.length === 0 && !announcement) return null
  const waiting = runs.filter((run) => run.status === 'waiting_permission' || run.waiting_keys.length > 0)
  const quiet = runs.filter((run) => !waiting.includes(run))
  const row = (run: ExecutionView) => (
    <RunRow dm={dm} key={run.run_id} run={run} stopping={stopping.has(run.run_id)} t={t} onStop={() => stop(run)} />
  )

  // On a phone the body is capped and scrolls, under a one-line summary, so
  // prompts never push the composer off screen.
  const summary = runs.length + items.length > 1
    ? t('kubecode.execution.summary', { working: runs.length, waiting: items.length })
    : null
  return (
    <section aria-label={t('kubecode.execution.workingNow')} className="kubecode-execution-strip">
      {summary && <p aria-hidden className="kubecode-execution-summary">{summary}</p>}
      <div aria-label={t('kubecode.execution.workingNow')} className="kubecode-execution-body" role="group">
        {(waiting.length > 0 || (quiet.length > 0 && quiet.length <= QUIET_ROWS) || failures.length > 0) && (
          <ul className="kubecode-execution-rows">
            {waiting.map(row)}
            {quiet.length <= QUIET_ROWS && quiet.map(row)}
            {failures.map((entry) => (
              <FailureRow
                failure={entry}
                key={entry.run_id}
                t={t}
                onDismiss={() => setDismissed((current) => [...current, entry.run_id])}
              />
            ))}
          </ul>
        )}
        {quiet.length > QUIET_ROWS && (
          <details className="kubecode-execution-more">
            <summary>{t('kubecode.execution.workingCount', { count: quiet.length })}</summary>
            <ul className="kubecode-execution-rows">{quiet.map(row)}</ul>
          </details>
        )}
        {items.map((item) => (item.kind === 'permission'
          ? <PermissionRow api={api} item={item} key={item.key} t={t} />
          : item.kind === 'input' ? <InputRow api={api} item={item} key={item.key} t={t} /> : null))}
      </div>
      <span className="sr-only" role="status">{announcement}</span>
    </section>
  )
}
