import { useId, type MouseEvent } from 'react'

import { ActionTooltip } from '@/components/ui/action-tooltip'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { Spinner as OfficialSpinner } from '@/components/ui/spinner'
import { ICON_SIZES } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS } from '@/kubecode/icons/workspaceIcons'

const Send = WORKSPACE_COMMAND_ICONS.send.Icon
const Stop = WORKSPACE_COMMAND_ICONS.stopRun.Icon
const Pause = WORKSPACE_COMMAND_ICONS.pauseOrchestration.Icon
const Resume = WORKSPACE_COMMAND_ICONS.resumeOrchestration.Icon

/** A busy control keeps focus and ignores clicks instead of being disabled (ADR 0227). */
function unlessBusy(busy: boolean, action: () => void) {
  return (event: MouseEvent) => {
    if (busy) {
      event.preventDefault()
      return
    }
    action()
  }
}

/** The official Spinner, silent here: the button's aria-busy already says it is working. */
function Spinner() {
  return <OfficialSpinner aria-hidden aria-label={undefined} className="motion-reduce:animate-none" role={undefined} />
}

export type SendButtonProps = {
  /** "Send" in the user's language. */
  label: string
  canSend: boolean
  /** A send is in flight; the button waits so one draft is not sent twice. */
  busy?: boolean
  onSend: () => void
  testId?: string
  /** Why it cannot send now, in words; it describes the button. */
  disabledReason?: string
}

/**
 * The arrow button every composer ends with. It stays available while agents
 * are working: sending a message is independent of stopping anything.
 */
export function SendButton({ busy = false, canSend, disabledReason, label, onSend, testId }: SendButtonProps) {
  const reasonId = useId()
  const reason = !canSend && !busy && disabledReason ? disabledReason : null
  return (
    <TooltipProvider>
      {reason && <span className="sr-only" id={reasonId}>{reason}</span>}
      <ActionTooltip copy={{ label }}>
        <Button
          aria-busy={busy || undefined}
          aria-describedby={reason ? reasonId : undefined}
          aria-disabled={busy || undefined}
          aria-label={label}
          className="kubecode-send-button"
          data-can-send={canSend && !busy}
          data-testid={testId}
          disabled={!canSend && !busy}
          size="icon-sm"
          type="button"
          variant="default"
          onClick={unlessBusy(busy, onSend)}
        >
          {busy ? <Spinner /> : <Send aria-hidden size={ICON_SIZES.default} />}
        </Button>
      </ActionTooltip>
    </TooltipProvider>
  )
}

export type StopButtonProps = {
  /** Names what it stops, for example "Stop Analyst's run". */
  label: string
  /**
   * The words shown on touch screens, where there are no tooltips, for
   * example "Stop run"; the full `label` stays its accessible name.
   */
  shortLabel?: string
  onStop: () => void
  testId?: string
  /** What stopping leaves running, read after the name. */
  description?: string
  /** The stop is being requested: it keeps focus and ignores clicks. */
  busy?: boolean
  /** A quiet ghost button where it sits in a list row. */
  variant?: 'outline' | 'ghost'
}

/**
 * Stops one named run now. It is separate from sending and always says what
 * it stops; on touch screens, where there are no tooltips, it says so in text.
 */
export function StopButton({ busy = false, description, label, onStop, shortLabel, testId, variant = 'outline' }: StopButtonProps) {
  const descriptionId = useId()
  return (
    <TooltipProvider>
      {description && <span className="sr-only" id={descriptionId}>{description}</span>}
      <ActionTooltip copy={{ label }}>
        <Button
          aria-busy={busy || undefined}
          aria-describedby={description ? descriptionId : undefined}
          aria-disabled={busy || undefined}
          aria-label={label}
          className="kubecode-stop-button"
          data-testid={testId}
          size="sm"
          type="button"
          variant={variant}
          onClick={unlessBusy(busy, onStop)}
        >
          {busy ? <Spinner /> : <Stop aria-hidden fill="currentColor" size={ICON_SIZES.status} />}
          <span aria-hidden="true" className="kubecode-stop-button-text">{shortLabel ?? label}</span>
        </Button>
      </ActionTooltip>
    </TooltipProvider>
  )
}

export type PauseButtonProps = {
  /**
   * Names the action and its scope, and does not change with the state, for
   * example "Pause new work on this Task". The pressed state says whether it
   * is paused.
   */
  label: string
  paused: boolean
  onToggle: () => void
  /** A short visible label; the accessible name (`label`) starts with it (WCAG 2.5.3). */
  text?: string
  busy?: boolean
  testId?: string
}

/**
 * Pauses or resumes handing out new work in a scope the caller names — a
 * Task's round, one work item, an execution's experiment launches (ADR 0227).
 * It is not `StopButton`:
 * stopping ends one named run now; pausing stops new work from starting and
 * lets running work finish. Neither replaces sending.
 */
export function PauseButton({ busy = false, label, onToggle, paused, testId, text }: PauseButtonProps) {
  return (
    <TooltipProvider>
      <ActionTooltip copy={{ label }}>
        <Button
          aria-busy={busy || undefined}
          aria-disabled={busy || undefined}
          aria-label={label}
          aria-pressed={paused}
          className="kubecode-pause-button"
          data-testid={testId}
          size={text ? 'sm' : 'icon-sm'}
          type="button"
          variant={paused ? 'secondary' : 'outline'}
          onClick={unlessBusy(busy, onToggle)}
        >
          {busy ? <Spinner /> : paused ? <Resume aria-hidden size={ICON_SIZES.default} /> : <Pause aria-hidden size={ICON_SIZES.default} />}
          {text}
        </Button>
      </ActionTooltip>
    </TooltipProvider>
  )
}
