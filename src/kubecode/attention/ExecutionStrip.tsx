import { ChevronDown } from 'lucide-react'
import { useContext, useEffect, useRef, useState, type CSSProperties } from 'react'

import {
  Queue,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from '@/components/ai-elements/queue'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { Translator } from '@/lib/i18n'

import { ApiError, type AgentEvent, type AttentionItem, type AttentionTaskRef, type ExecutionFailure, type ExecutionView, type KubecodeApi } from '../api'
import { placeKey, usePlaceState } from '../app/location/placeMemory'
import { WorkspaceNavigationContext } from '../app/location/WorkspaceNavigation'
import { elicitationFromEvent, type ElicitationAnswer } from '../session/conversationReducer'
import { elicitationContent, initialElicitationAnswers } from '../session/sessionModel'
import { askerName } from './attentionTargets'
import { useAttention, type ExecutionScope } from './attentionContext'
import { ElicitationPrompt } from './ElicitationPrompt'
import { ExecutionRow } from './ExecutionRow'
import { PermissionPrompt } from './PermissionPrompt'

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

/** One Stop per Task: every turn on it, or one reply that belongs to no Task. */
type Entry = { key: string; runs: ExecutionView[]; task: AttentionTaskRef | null }

function entriesOf(runs: ExecutionView[]): Entry[] {
  const entries = new Map<string, Entry>()
  for (const run of runs) {
    const task = run.tasks[0] ?? null
    const key = task ? `task:${task.id}` : `run:${run.run_id}`
    const entry = entries.get(key)
    if (entry) entry.runs.push(run)
    else entries.set(key, { key, runs: [run], task })
  }
  return [...entries.values()]
}

function FailureRow({ failure, onDismiss, t }: { failure: ExecutionFailure; onDismiss: () => void; t: Translator }) {
  const navigation = useContext(WorkspaceNavigationContext)
  const key = failure.status === 'interrupted' ? 'kubecode.execution.turnInterrupted' : 'kubecode.execution.turnFailed'
  // A failed turn is an official destructive Alert, not announced again: it is shown until dismissed.
  return (
    <li data-state="failed">
      <Alert role={undefined} variant="destructive">
        <AlertDescription className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{t(key, { name: failure.member.name })}</span>
          {/* The member's profile holds what fixes a failing turn: its Session, its setup. */}
          {navigation && (
            <Button
              className="pointer-coarse:min-h-11"
              size="xs"
              variant="outline"
              onClick={() => navigation.openPlace({ view: 'members' }, { inspect: { kind: 'member', id: failure.member.id } })}
            >
              {t('kubecode.execution.openMember', { name: failure.member.name })}
            </Button>
          )}
          <Button className="pointer-coarse:min-h-11" size="xs" variant="ghost" onClick={onDismiss}>{t('kubecode.execution.dismiss')}</Button>
        </AlertDescription>
      </Alert>
    </li>
  )
}

/**
 * Who is working now (ADR 0238, superseding ADR 0232 §6's Stop): one
 * Stop per Task — it pauses new work on the Task and ends its turns — or per
 * reply that belongs to no Task; more than one folds into a count that opens
 * the list. The permission or input a member waits on stays in view, answered
 * in place, and a member's last failed turn shows once, until dismissed.
 */
export function ExecutionStrip({ api, prompts = true, scope, t }: ExecutionStripProps) {
  const attention = useAttention()
  const runs = attention?.executions(scope) ?? []
  const entries = entriesOf(runs)
  const items = prompts ? attention?.snapshot?.items.filter((item) => inScope(scope, item)) ?? [] : []
  const projectId = attention?.projectId ?? null
  const [dismissed, setDismissed] = usePlaceState<string[]>(
    projectId ? `${placeKey.view(projectId, 'general')}#dismissedFailures` : null,
    [],
  )
  const failures = (attention?.failures(scope) ?? []).filter((entry) => !dismissed.includes(entry.run_id))

  // A stop is busy until its entry leaves the snapshot; then it is announced.
  const [stopping, setStopping] = useState<ReadonlyMap<string, Entry>>(new Map())
  const [announcement, setAnnouncement] = useState('')
  const live = new Set(entries.map((entry) => entry.key))
  const stopped = [...stopping.values()].filter((entry) => !live.has(entry.key))
  if (stopped.length > 0) {
    const next = new Map(stopping)
    stopped.forEach((entry) => next.delete(entry.key))
    setStopping(next)
    const entry = stopped[0]
    setAnnouncement(entry.task
      ? t('kubecode.execution.stoppedTask', { task: entry.task.title })
      : t('kubecode.execution.stopped', { name: nameOf(entry.runs[0], t) }))
  }
  const timers = useRef(new Set<number>())
  const section = useRef<HTMLElement>(null)
  // The running list opens as wide as the strip, and so the card, it belongs to (ADR 0240).
  const [listWidth, setListWidth] = useState<number | null>(null)
  // Opened by a pointer, the list takes focus without a ring; from the keyboard it shows one.
  const [openedBy, setOpenedBy] = useState<'pointer' | 'keyboard'>('keyboard')
  const measure = (open: boolean) => {
    if (!open) return
    const width = section.current?.getBoundingClientRect().width ?? 0
    setListWidth(width > 0 ? width : null)
  }
  useEffect(() => {
    const pending = timers.current
    return () => pending.forEach((timer) => window.clearTimeout(timer))
  }, [])
  const pauseTask = async (taskId: string) => {
    if (!projectId) return
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const execution = (await api.taskDetail(projectId, taskId)).execution
      if (!execution || execution.paused) return
      try {
        await api.setRoundExecutionPolicy(projectId, execution.round_id, execution.policy_revision, { paused: true })
        return
      } catch (cause) {
        // Changed elsewhere meanwhile: read it again and pause what is there now.
        if (!(cause instanceof ApiError && cause.code === 'policy_revision_conflict') || attempt > 0) throw cause
      }
    }
  }
  const stop = async (entry: Entry) => {
    if (stopping.has(entry.key)) return
    setAnnouncement('')
    setStopping((current) => new Map(current).set(entry.key, entry))
    try {
      // Pause first, so nothing new is handed out while the turns end.
      const tasks = new Set(entry.runs.flatMap((run) => run.tasks.map((task) => task.id)))
      for (const taskId of tasks) await pauseTask(taskId)
      await Promise.all(entry.runs.map((run) => api.cancelRun(run.run_id)))
      attention?.reload()
      const timer = window.setTimeout(() => {
        timers.current.delete(timer)
        attention?.reload()
      }, STOP_FALLBACK_MS)
      timers.current.add(timer)
    } catch {
      setStopping((current) => {
        const next = new Map(current)
        next.delete(entry.key)
        return next
      })
      setAnnouncement(entry.task
        ? t('kubecode.execution.stopTaskFailed', { task: entry.task.title })
        : t('kubecode.execution.stopFailed', { name: nameOf(entry.runs[0], t) }))
      attention?.reload()
    }
  }

  if (entries.length === 0 && items.length === 0 && failures.length === 0 && !announcement) return null
  const row = (entry: Entry, alone = false) => (
    <ExecutionRow
      alone={alone}
      entryKey={entry.key}
      key={entry.key}
      runs={entry.runs}
      stopping={stopping.has(entry.key)}
      t={t}
      task={entry.task}
      onStop={() => void stop(entry)}
    />
  )
  const busy = stopping.size > 0
  return (
    <section aria-label={t('kubecode.execution.workingNow')} className="kubecode-execution-strip flex flex-col gap-2" ref={section}>
      {/* Decisions are never folded away; on a phone their body is capped and scrolls. */}
      {items.length > 0 && (
        <div aria-label={t('kubecode.execution.waitingForYou')} className="kubecode-execution-body flex min-h-0 flex-col gap-2" role="group">
          {items.map((item) => (item.kind === 'permission'
            ? <PermissionRow api={api} item={item} key={item.key} t={t} />
            : item.kind === 'input' ? <InputRow api={api} item={item} key={item.key} t={t} /> : null))}
        </div>
      )}
      {entries.length === 1 && <ul className="kubecode-execution-rows flex flex-col gap-1">{entries.map((entry) => row(entry, true))}</ul>}
      {entries.length > 1 && (
        <Popover onOpenChange={measure}>
          <PopoverTrigger asChild>
            <Button
              aria-busy={busy || undefined}
              className="self-start"
              size="sm"
              type="button"
              variant="outline"
              onKeyDown={() => setOpenedBy('keyboard')}
              onPointerDown={() => setOpenedBy('pointer')}
            >
              <Shimmer as="span" className="kubecode-shimmer">{t('kubecode.execution.runningCount', { count: entries.length })}</Shimmer>
              <ChevronDown aria-hidden data-icon="inline-end" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            aria-label={t('kubecode.execution.workingNow')}
            // As wide as the dock it opens from; a ring only when opened from the keyboard.
            className="max-h-[40vh] w-[var(--kubecode-execution-popover-width,min(28rem,calc(100vw-32px)))] overflow-y-auto p-1 outline-none data-[opened-by=keyboard]:focus-visible:ring-[3px] data-[opened-by=keyboard]:focus-visible:ring-ring/50"
            data-opened-by={openedBy}
            side="top"
            style={listWidth ? { '--kubecode-execution-popover-width': `${listWidth}px` } as CSSProperties : undefined}
            tabIndex={-1}
            // Focus lands on the list, not its first Stop: no tooltip opens and Escape closes it.
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              ;(event.currentTarget as HTMLElement).focus()
            }}
          >
            {/* The running list as a Queue (ADR 0242): one section, each row a piece of work with its Stop. */}
            <Queue>
              <QueueSection>
                <QueueSectionTrigger>
                  <QueueSectionLabel label={t('kubecode.execution.runningCount', { count: entries.length })} />
                </QueueSectionTrigger>
                <QueueSectionContent>
                  {/* The popover scrolls; a second scroll area inside it would clip the rows. */}
                  <ul className="kubecode-execution-rows flex flex-col gap-1">{entries.map((entry) => row(entry))}</ul>
                </QueueSectionContent>
              </QueueSection>
            </Queue>
          </PopoverContent>
        </Popover>
      )}
      {failures.length > 0 && (
        <ul className="flex flex-col gap-1">
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
      <span className="sr-only" role="status">{announcement}</span>
    </section>
  )
}
