import { useEffect, useRef, useState } from 'react'

import './message-actions.css'

/**
 * ADR 0257, adapting the affectUI "Message Actions"
 * (https://www.affectui.com/components/message-actions, Clean preview,
 * captured 2026-10-26): one quiet copy action whose icon morphs into a check
 * on success and whose failure stays actionable. Reproduced: the 28px ghost
 * button, the two-layer blur morph between icon states, the success tone,
 * the press scale. Deviations: regenerate, voting and read-aloud are not
 * implemented — Kubecode has no such domain handlers (the parent contract
 * forbids actions without one); all labels come from the caller, localized;
 * clipboard failure surfaces the caller's error label and the next click
 * retries, instead of a silent catch.
 *
 * States: idle, copied (success morph), failed (error label), busy prevented
 * by the in-flight guard; `#/controls` (AgentUiMatrix) demonstrates them.
 */

export interface CopyActionProps {
  /** Reads the text to copy at click time, so the copy is always current. */
  getText: () => string
  /** Accessible name while idle. Localized. */
  label: string
  /** Accessible name and tooltip while copied shows. Localized. */
  copiedLabel: string
  /** Accessible name shown when the clipboard refused. Localized. */
  errorLabel: string
  icon: React.ReactNode
  copiedIcon?: React.ReactNode
  errorIcon?: React.ReactNode
  onCopied?: (text: string) => void
  className?: string
}

type CopyState = 'idle' | 'copied' | 'error'

export function CopyAction({
  getText,
  label,
  copiedLabel,
  errorLabel,
  icon,
  copiedIcon = icon,
  errorIcon = icon,
  onCopied,
  className,
}: CopyActionProps) {
  const [state, setState] = useState<CopyState>('idle')
  const inFlight = useRef(false)
  const timer = useRef(0)

  useEffect(() => {
    if (state === 'idle') return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setState('idle'), 1800)
    return () => window.clearTimeout(timer.current)
  }, [state])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const name = state === 'copied' ? copiedLabel : state === 'error' ? errorLabel : label

  return (
    <button
      type="button"
      className={className ? `agx-copy ${className}` : 'agx-copy'}
      data-state={state}
      aria-label={name}
      title={name}
      onClick={() => {
        if (inFlight.current) return
        inFlight.current = true
        let text: string
        try {
          text = getText()
        } catch {
          inFlight.current = false
          setState('error')
          return
        }
        // A clipboard without permission rejects; the error state keeps the
        // action available so the next click retries.
        window.navigator.clipboard
          ?.writeText(text)
          .then(() => {
            inFlight.current = false
            setState('copied')
            onCopied?.(text)
          })
          .catch(() => {
            inFlight.current = false
            setState('error')
          })
      }}
    >
      <span className="agx-copy__morph" aria-hidden="true">
        <span className="agx-copy__layer" data-on={state === 'copied' || undefined}>
          {copiedIcon}
        </span>
        <span className="agx-copy__layer" data-on={state === 'error' || undefined}>
          {errorIcon}
        </span>
        <span className="agx-copy__layer" data-on={state === 'idle' || undefined}>
          {icon}
        </span>
      </span>
    </button>
  )
}
