import { ShieldAlert } from 'lucide-react'
import { useEffect, useState } from 'react'

import { DecisionButton } from '@/components/workspace/DecisionButton'
import type { Translator } from '@/lib/i18n'

import type { PendingOption } from '../api'
import { permissionChoiceLabel } from '../session/sessionModel'
import { isGone } from './attentionContext'

export type PermissionPromptProps = {
  requestId: string
  /** The tool's title as the provider gave it; never its input. */
  tool: string
  options: PendingOption[]
  /** When the server declines the request by itself (epoch milliseconds); null when it enforces no deadline, as for permission requests. */
  deadlineMs: number | null
  /** Who asks and for which Task; "Permission required" when absent. */
  heading?: string
  onResolve: (optionId: string) => Promise<void> | void
  /** The request is gone: answered elsewhere, timed out, or its turn stopped. */
  onGone?: () => void
  /** Answered, and waiting for the server to drop it: nothing answers it again. */
  resolving?: boolean
  t: Translator
}

/**
 * A permission request, answered in place (ADR 0232): the tool in code, the
 * time left, and each option as a decision, 1–9 from the keyboard. It stays
 * while the answer is recorded and says so when it was not.
 */
export function PermissionPrompt({ deadlineMs, heading, onGone, onResolve, options, requestId, resolving = false, t, tool }: PermissionPromptProps) {
  const [busy, setBusy] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<'failed' | 'gone' | null>(null)
  const title = heading ?? t('kubecode.permissionRequired')
  const resolve = async (optionId: string) => {
    if (busy || resolving) return
    setBusy(optionId)
    setOutcome(null)
    try {
      await onResolve(optionId)
    } catch (cause) {
      if (isGone(cause)) {
        setOutcome('gone')
        onGone?.()
      } else {
        setOutcome('failed')
      }
    } finally {
      setBusy(null)
    }
  }
  return (
    // Only changes are announced (the outcome lines below); the countdown is not.
    <div
      aria-label={`${title}: ${tool}`}
      className="kubecode-permission-dock"
      data-focus-key={`permission:${requestId}`}
      data-testid="permission-queue-card"
      role="group"
      tabIndex={0}
      onKeyDown={(event) => {
        // 1–9 keyboard option select (#111).
        const digit = Number.parseInt(event.key, 10)
        if (!Number.isNaN(digit) && digit >= 1 && digit <= options.length) void resolve(options[digit - 1].id)
      }}
    >
      <div className="kubecode-permission-heading">
        <ShieldAlert aria-hidden size={17} />
        <strong>{title}</strong>
        {deadlineMs !== null && <PermissionCountdown deadlineMs={deadlineMs} t={t} />}
      </div>
      <code className="kubecode-permission-command">{tool}</code>
      <div className="kubecode-permission-actions">
        {options.map((option, index) => (
          <DecisionButton
            busy={busy === option.id || resolving}
            key={option.id}
            title={`${index + 1} — ${option.label}`}
            variant={option.kind.startsWith('reject') ? 'secondary' : 'primary'}
            onDecide={() => void resolve(option.id)}
          >
            {permissionChoiceLabel(option, t)}
          </DecisionButton>
        ))}
      </div>
      {resolving && <p className="kubecode-research-muted" role="status">{t('kubecode.attention.resolving')}</p>}
      {outcome === 'failed' && <p className="kubecode-research-error" role="alert">{t('kubecode.attention.resolveFailed')}</p>}
      {outcome === 'gone' && <p className="kubecode-research-muted" role="status">{t('kubecode.attention.answeredElsewhere')}</p>}
    </div>
  )
}

function remainingSeconds(deadlineMs: number): number {
  return Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000))
}

export function PermissionCountdown({ deadlineMs, t }: { deadlineMs: number; t: Translator }) {
  const [remaining, setRemaining] = useState(() => remainingSeconds(deadlineMs))
  useEffect(() => {
    const timer = window.setInterval(() => setRemaining(remainingSeconds(deadlineMs)), 1000)
    return () => window.clearInterval(timer)
  }, [deadlineMs])
  // Past its deadline the server declines it and the prompt goes: never a "0 s".
  if (remaining <= 0) return null
  const urgent = remaining < 30
  return (
    <span
      className={urgent ? 'text-destructive font-semibold' : 'text-muted-foreground'}
      data-testid="permission-countdown"
      data-urgent={urgent}
    >
      {remaining >= 60
        ? t('kubecode.permissionExpiresMinutes', { count: Math.ceil(remaining / 60) })
        : t('kubecode.permissionExpiresSeconds', { count: remaining })}
    </span>
  )
}
