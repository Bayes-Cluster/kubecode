import { useState } from 'react'

import { Spinner } from '@/components/ui/spinner'
import { Toggle } from '@/components/ui/toggle'
import { ICON_SIZES } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS } from '@/kubecode/icons/workspaceIcons'
import type { Translator } from '@/lib/i18n'

import { ApiError, type KubecodeApi, type TaskExecution } from '../api'
import { errorMessage } from '../app/errors'

const Pause = WORKSPACE_COMMAND_ICONS.pauseOrchestration.Icon
const Resume = WORKSPACE_COMMAND_ICONS.resumeOrchestration.Icon

export type RoundPauseControlProps = {
  api: KubecodeApi
  projectId: string
  task: { id: string; title: string }
  execution: TaskExecution
  /** Reads the Task again after a change, or when its limits changed elsewhere. */
  onChanged: () => void
  t: Translator
}

/**
 * "Pause new work on {task}" (ADR 0232): the executing round's policy. It
 * stops new work being handed out and lets running turns and experiments
 * continue; its name never changes, and the pressed state says whether it is
 * paused. A change made elsewhere meanwhile is shown, never overwritten.
 */
export function RoundPauseControl({ api, execution, onChanged, projectId, t, task }: RoundPauseControlProps) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const label = t('kubecode.execution.pauseTaskWork', { task: task.title })
  const toggle = async () => {
    setBusy(true)
    setNotice(null)
    try {
      await api.setRoundExecutionPolicy(projectId, execution.round_id, execution.policy_revision, { paused: !execution.paused })
      onChanged()
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'policy_revision_conflict') {
        setNotice(t('kubecode.execution.policyChanged'))
        onChanged()
      } else {
        setNotice(errorMessage(cause, t('kubecode.error')))
      }
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2" data-paused={execution.paused}>
      {/* Its name never changes; the pressed state says whether new work is paused (ADR 0232, ADR 0255). */}
      <Toggle
        aria-busy={busy || undefined}
        aria-disabled={busy || undefined}
        aria-label={label}
        pressed={execution.paused}
        size="sm"
        variant="outline"
        onPressedChange={busy ? undefined : () => void toggle()}
      >
        {busy ? <Spinner aria-hidden="true" /> : execution.paused ? <Resume aria-hidden size={ICON_SIZES.default} /> : <Pause aria-hidden size={ICON_SIZES.default} />}
        {t('kubecode.execution.pauseWorkShort')}
      </Toggle>
      {notice && <p className="min-w-56 flex-1 text-sm text-muted-foreground" role="status">{notice}</p>}
    </div>
  )
}
