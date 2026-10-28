import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type HTMLAttributes,
} from 'react'

import './composer.css'

/**
 * ADR 0257, adapting the affectUI "Chat Composer"
 * (https://www.affectui.com/components/chat-composer, Clean preview,
 * captured 2026-10-28) onto the official Prompt Input, which stays the
 * engine — its IME, keyboard, paste and upload contract is authoritative
 * (ADR 0257 §2; slice E1's terms: "retain the inline editor behind the
 * common presentation"). Reproduced: the inset card with the hairline body,
 * the focus state on the card rather than the field, context chips above
 * the field, the action rail below it (tools left, send right), the
 * animated auto-height, and the quiet send affordance. Deviations: no
 * voice/recording affordances and no price/hosted-provider content —
 * Kubecode has no such data to show (ADR 0257 §3); coarse pointers keep
 * the ADR 0256 44px targets instead of the reference's 34px controls.
 *
 * States: `#/controls` (AgentUiMatrix) shows the card's field, chips and
 * rail through the production channel composer.
 */

/** The composer card: the inset body that carries the focus state. */
export function AgxComposer({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  const [focused, setFocused] = useState(false)
  // The card, not the field, answers for focus: focus entering any part of
  // the composer lights the frame, as the reference does.
  const onFocus = useCallback(() => setFocused(true), [])
  const onBlur = useCallback((event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
  }, [])
  return (
    <div
      {...props}
      className={className ? `agx-comp ${className}` : 'agx-comp'}
      data-focused={focused ? '' : undefined}
      onBlur={onBlur}
      onFocus={onFocus}
    >
      {children}
    </div>
  )
}

/**
 * The write region. It presents the engine's textarea — transparent, no
 * outline, accent caret — and owns the auto-height: the reference glides
 * between measured line heights, while the engine's `field-sizing` snaps.
 * `value` (the same string the caller already holds) is only the
 * measurement trigger; the textarea keeps every behaviour the engine gives
 * it. `min` and `max` bound the animated height in pixels; beyond `max`
 * the field scrolls.
 */
export function AgxComposerField({
  value,
  min,
  max,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  value: string
  min?: number
  max?: number
}) {
  const field = useRef<HTMLDivElement | null>(null)

  const fit = useCallback(() => {
    const area = field.current?.querySelector('textarea')
    if (!area) return
    area.setAttribute('data-autosize', '')
    // Measure the text, not the box: auto returns the field-sizing height
    // (the engine's own floor), then the measured height takes over. The
    // stylesheet's own max-height (a shorter viewport's 40dvh, say) may
    // still clamp the box below the measured height, so scrolling stays
    // the stylesheet's business — this never writes overflow.
    area.style.setProperty('height', 'auto')
    const text = Math.max(area.scrollHeight, min ?? 0)
    const height = Math.min(text, max ?? Number.POSITIVE_INFINITY)
    area.style.setProperty('height', `${height}px`)
  }, [min, max])

  // Compositions update the value too (the engine mirrors them into the
  // controlled string), so the value alone drives the measurement.
  useLayoutEffect(fit, [fit, value])

  // Reflow (a narrower pane rewraps the text) needs a re-measure even when
  // the value is unchanged. The observer settles: a re-measure that lands
  // on the same height changes nothing further.
  useEffect(() => {
    const area = field.current?.querySelector('textarea')
    const box = field.current
    if (!area || !box || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => fit())
    observer.observe(box)
    return () => observer.disconnect()
  }, [fit])

  return (
    <div
      {...props}
      ref={field}
      className={className ? `agx-comp__field ${className}` : 'agx-comp__field'}
    >
      {children}
    </div>
  )
}

/** The action rail: tools on the left, stop and send on the right. */
export function AgxComposerRail({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} className={className ? `agx-comp__rail ${className}` : 'agx-comp__rail'}>
      {children}
    </div>
  )
}

/** One context chip: the accent glyph, the label, then anything after. */
export function AgxComposerChip({
  children,
  className,
  accent = true,
  label,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  accent?: boolean
  /** The chip's full text, kept for the truncation tooltip. */
  label: string
}) {
  return (
    <span
      {...props}
      className={className ? `agx-comp__chip ${className}` : 'agx-comp__chip'}
      data-accent={accent ? '' : undefined}
    >
      <span className="agx-comp__chip-label" title={label}>
        {children ?? label}
      </span>
    </span>
  )
}

/** Notices under the field: hints and errors the caller renders. */
export function AgxComposerNotices({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} className={className ? `agx-comp__notices ${className}` : 'agx-comp__notices'}>
      {children}
    </div>
  )
}
