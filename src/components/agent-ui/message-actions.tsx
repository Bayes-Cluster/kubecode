import { useEffect, useRef, useState, type ReactNode } from 'react'

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
  /** Called with the outcome, for a surface that announces it in words. */
  onFinished?: (ok: boolean) => void
  /** A visible label beside the icon: the labelled variant keeps the words
   * where the surface shows them (settings rows), instead of the icon-only
   * quiet action (message rows). */
  children?: ReactNode
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
  onFinished,
  children,
  className,
}: CopyActionProps) {
  const [state, setState] = useState<CopyState>('idle')
  const inFlight = useRef(false)
  const timer = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      window.clearTimeout(timer.current)
    }
  }, [])

  // Each completion restarts the acknowledgment window, so a re-copy while
  // "Copied" shows does not shorten it.
  const finish = (next: CopyState) => {
    if (!mounted.current) return
    setState(next)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      if (mounted.current) setState('idle')
    }, 1800)
  }

  const name = state === 'copied' ? copiedLabel : state === 'error' ? errorLabel : label

  return (
    <button
      type="button"
      className={(className ? `agx-copy ${className}` : 'agx-copy') + (children ? ' agx-copy--labelled' : '')}
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
          finish('error')
          onFinished?.(false)
          return
        }
        // A clipboard without permission (or without the API at all) refuses;
        // the error state keeps the action available so the next click retries.
        let write: Promise<void> | undefined
        try {
          write = window.navigator.clipboard?.writeText(text)
        } catch {
          write = undefined
        }
        if (!write) {
          inFlight.current = false
          finish('error')
          onFinished?.(false)
          return
        }
        write
          .then(() => {
            inFlight.current = false
            finish('copied')
            if (mounted.current) {
              onCopied?.(text)
              onFinished?.(true)
            }
          })
          .catch(() => {
            inFlight.current = false
            finish('error')
            if (mounted.current) onFinished?.(false)
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
      {children && <span className="agx-copy__label">{children}</span>}
    </button>
  )
}
