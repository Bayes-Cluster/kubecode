import { Shimmer } from '@/components/ai-elements'
import { MemberIdentity } from '@/components/workspace/MemberIdentity'
import { StopButton } from '@/components/workspace/SendButton'
import type { Translator } from '@/lib/i18n'

import type { AttentionTaskRef, ExecutionView } from '../api'
import { askerName } from './attentionTargets'

export type ExecutionRowProps = {
  entryKey: string
  /** Every turn this Stop ends: all the turns on one Task, or one reply. */
  runs: ExecutionView[]
  task: AttentionTaskRef | null
  stopping: boolean
  onStop: () => void
  t: Translator
}

function waitText(runs: ExecutionView[], t: Translator): string | null {
  if (runs.some((run) => run.waiting_keys.length > 0)) return t('kubecode.execution.waitingYou')
  // Waiting with nothing the researcher can answer: a Team leader reviews it first.
  if (runs.some((run) => run.status === 'waiting_permission')) return t('kubecode.execution.waitingLead')
  return null
}

/**
 * One piece of work at the dock, alone or in the running list (#229): who,
 * with their handle, a queued count and one Stop on the first line; the Task,
 * or "Replying", on the second. The name is never repeated in the status.
 */
export function ExecutionRow({ entryKey, onStop, runs, stopping, t, task }: ExecutionRowProps) {
  const name = askerName(runs[0], t)
  const queued = runs.reduce((sum, run) => sum + run.queued, 0)
  const waiting = waitText(runs, t)
  const title = task ? task.title : t('kubecode.execution.replying')
  return (
    <li className="kubecode-execution-row" data-entry={entryKey}>
      <span className="kubecode-execution-line">
        <span className="kubecode-execution-who">
          {runs.map((run) => (run.member
            ? <MemberIdentity handle={run.member.handle} key={run.run_id} name={run.member.name} role={run.member.role === 'general' ? 'manager' : 'specialist'} size="sm" />
            : <strong key={run.run_id}>{askerName(run, t)}</strong>))}
        </span>
        {queued > 0 && <span className="kubecode-execution-queued">{t('kubecode.execution.queuedCount', { count: queued })}</span>}
        <StopButton
          busy={stopping}
          description={task
            ? t('kubecode.execution.stopTaskHint', { task: task.title })
            : t('kubecode.execution.stopReplyHint', { name })}
          label={task
            ? t('kubecode.execution.stopTask', { task: task.title })
            : t('kubecode.execution.stopReply', { name })}
          shortLabel={task ? t('kubecode.execution.stopTaskShort') : t('kubecode.execution.stopReplyShort')}
          variant="ghost"
          onStop={onStop}
        />
      </span>
      <span className="kubecode-execution-state">
        {stopping
          ? t('kubecode.execution.stopping')
          : waiting
            ? <>{waiting}{' · '}<span className="kubecode-execution-title" title={title}>{title}</span></>
            : <span className="kubecode-execution-title" title={title}><Shimmer>{title}</Shimmer></span>}
      </span>
    </li>
  )
}
