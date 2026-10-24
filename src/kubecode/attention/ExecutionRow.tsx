import { QueueItem } from '@/components/ai-elements/queue'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { useId } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { MemberIdentity } from '@/components/workspace/MemberIdentity'
import { ICON_SIZES } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS } from '@/kubecode/icons/workspaceIcons'
import type { Translator } from '@/lib/i18n'

import type { AttentionTaskRef, ExecutionView } from '../api'
import { askerName } from './attentionTargets'

const StopGlyph = WORKSPACE_COMMAND_ICONS.stopRun.Icon

export type ExecutionRowProps = {
  /** The only running work at the dock: framed as an outline Item on its own. */
  alone?: boolean
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
export function ExecutionRow({ alone = false, entryKey, onStop, runs, stopping, t, task }: ExecutionRowProps) {
  const name = askerName(runs[0], t)
  const queued = runs.reduce((sum, run) => sum + run.queued, 0)
  const waiting = waitText(runs, t)
  const title = task ? task.title : t('kubecode.execution.replying')
  const stopHintId = useId()
  const stopLabel = task ? t('kubecode.execution.stopTask', { task: task.title }) : t('kubecode.execution.stopReply', { name })
  return (
    // A Queue item (ADR 0242) holding one Item: who and the Stop on the first line, the work on the second.
    <QueueItem className="kubecode-execution-row list-none p-0" data-entry={entryKey}>
      <Item className="w-full flex-nowrap py-1.5" size="sm" variant={alone ? 'outline' : 'default'}>
        <ItemContent className="min-w-0 gap-0.5">
          <ItemTitle className="flex w-full min-w-0 items-center gap-2">
            <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
              {runs.map((run) => (run.member
                ? <MemberIdentity className="min-w-0 overflow-hidden whitespace-nowrap" handle={run.member.handle} key={run.run_id} name={run.member.name} role={run.member.role === 'general' ? 'manager' : 'specialist'} size="sm" />
                : <strong key={run.run_id}>{askerName(run, t)}</strong>))}
            </span>
            {queued > 0 && <Badge className="kubecode-execution-queued shrink-0" variant="secondary">{t('kubecode.execution.queuedCount', { count: queued })}</Badge>}
          </ItemTitle>
          <ItemDescription className="kubecode-execution-state line-clamp-1">
            {stopping
              ? t('kubecode.execution.stopping')
              : waiting
                ? <>{waiting}{' · '}<span className="kubecode-execution-title" title={title}>{title}</span></>
                : <span className="kubecode-execution-title" title={title}><Shimmer as="span" className="kubecode-shimmer">{title}</Shimmer></span>}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          {/* Stops every turn of this row now, apart from sending; on touch it says so in text (ADR 0227, ADR 0256). */}
          <span className="sr-only" id={stopHintId}>
            {task ? t('kubecode.execution.stopTaskHint', { task: task.title }) : t('kubecode.execution.stopReplyHint', { name })}
          </span>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-busy={stopping || undefined}
                  aria-describedby={stopHintId}
                  aria-disabled={stopping || undefined}
                  aria-label={stopLabel}
                  size="sm"
                  variant="ghost"
                  onClick={stopping ? undefined : onStop}
                >
                  {stopping ? <Spinner aria-hidden="true" /> : <StopGlyph aria-hidden fill="currentColor" size={ICON_SIZES.status} />}
                  <span aria-hidden="true" className="pointer-fine:sr-only">
                    {task ? t('kubecode.execution.stopTaskShort') : t('kubecode.execution.stopReplyShort')}
                  </span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>{stopLabel}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </ItemActions>
      </Item>
    </QueueItem>
  )
}
