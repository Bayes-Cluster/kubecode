import { ShieldAlert } from 'lucide-react'
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'

import {
  Confirmation,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from '@/components/ai-elements/confirmation'
import type { Translator } from '@/lib/i18n'

import type { PendingOption } from '../api'
import { permissionChoiceLabel } from '../session/sessionModel'
import { isGone } from './attentionContext'
import { PromptDecision } from './PromptDecision'

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
  const rootRef = useRef<HTMLDivElement>(null)
  useFocusHandoff(rootRef)
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
    // The official Confirmation (ADR 0242), a named group rather than an alert:
    // only changes are announced (the outcome lines below); the countdown is not.
    <Confirmation
      approval={{ id: requestId }}
      aria-label={`${title}: ${tool}`}
      className="kubecode-permission-dock"
      data-focus-key={`permission:${requestId}`}
      data-testid="permission-queue-card"
      role="group"
      state="approval-requested"
      tabIndex={0}
      ref={rootRef}
      onKeyDown={(event) => {
        // 1–9 keyboard option select (#111).
        const digit = Number.parseInt(event.key, 10)
        if (!Number.isNaN(digit) && digit >= 1 && digit <= options.length) void resolve(options[digit - 1].id)
      }}
    >
      <ShieldAlert aria-hidden size={17} />
      <ConfirmationTitle className="kubecode-permission-heading">
        <strong>{title}</strong>
        {deadlineMs !== null && <PermissionCountdown deadlineMs={deadlineMs} t={t} />}
      </ConfirmationTitle>
      <ConfirmationRequest>
        <code className="kubecode-permission-command">{tool}</code>
      </ConfirmationRequest>
      <ConfirmationActions className="kubecode-permission-actions">
        {options.map((option, index) => (
          <PromptDecision
            busy={busy === option.id || resolving}
            key={option.id}
            title={`${index + 1} — ${option.label}`}
            variant={option.kind.startsWith('reject') ? 'secondary' : 'primary'}
            onDecide={() => void resolve(option.id)}
          >
            {permissionChoiceLabel(option, t)}
          </PromptDecision>
        ))}
      </ConfirmationActions>
      {resolving && <p className="kubecode-research-muted" role="status">{t('kubecode.attention.resolving')}</p>}
      {outcome === 'failed' && <p className="kubecode-research-error" role="alert">{t('kubecode.attention.resolveFailed')}</p>}
      {outcome === 'gone' && <p className="kubecode-research-muted" role="status">{t('kubecode.attention.answeredElsewhere')}</p>}
    </Confirmation>
  )
}

/**
 * When the prompt holding focus goes (answered, timed out), focus moves to the
 * next permission prompt, or else the composer, instead of falling to <body> (#229).
 */
function useFocusHandoff(rootRef: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const root = rootRef.current
    return () => {
      if (!root || !root.contains(document.activeElement)) return
      const doc = root.ownerDocument
      window.setTimeout(() => {
        if (doc.activeElement && doc.activeElement !== doc.body) return
        const next = Array.from(doc.querySelectorAll<HTMLElement>('[data-focus-key^="permission:"]')).find((node) => node !== root && node.isConnected)
        const target = next ?? doc.querySelector<HTMLElement>('.kubecode-composer-textarea')
        target?.focus()
      }, 0)
    }
  }, [rootRef])
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
