import { ArrowUp, Loader2, Square } from 'lucide-react'

import { ActionTooltip } from '@/components/ui/action-tooltip'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'

export type SendButtonProps = {
  /** "Send" in the user's language. */
  label: string
  canSend: boolean
  /** A send is in flight; the button waits so one draft is not sent twice. */
  busy?: boolean
  onSend: () => void
  testId?: string
}

/**
 * The arrow button every composer ends with. It stays available while agents
 * are working: sending a message is independent of stopping anything.
 */
export function SendButton({ busy = false, canSend, label, onSend, testId }: SendButtonProps) {
  return (
    <TooltipProvider>
      <ActionTooltip copy={{ label }}>
        <Button
          aria-busy={busy || undefined}
          aria-label={label}
          className="kubecode-send-button"
          data-can-send={canSend}
          data-testid={testId}
          disabled={!canSend || busy}
          size="icon-sm"
          type="button"
          variant="ghost"
          onClick={onSend}
        >
          {busy ? <Loader2 aria-hidden className="animate-spin" size={16} /> : <ArrowUp aria-hidden size={17} />}
        </Button>
      </ActionTooltip>
    </TooltipProvider>
  )
}

export type StopButtonProps = {
  /** Names what it stops, for example "Stop Analyst". */
  label: string
  onStop: () => void
  testId?: string
}

/** Stops one named task or agent. It is separate from sending and always says what it stops. */
export function StopButton({ label, onStop, testId }: StopButtonProps) {
  return (
    <TooltipProvider>
      <ActionTooltip copy={{ label }}>
        <Button
          aria-label={label}
          className="kubecode-stop-button"
          data-testid={testId}
          size="icon-sm"
          type="button"
          variant="ghost"
          onClick={onStop}
        >
          <Square aria-hidden fill="currentColor" size={13} />
        </Button>
      </ActionTooltip>
    </TooltipProvider>
  )
}
