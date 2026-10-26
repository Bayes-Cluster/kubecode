import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import './segmented-control.css'

/**
 * ADR 0257, recreating the affectUI "Segmented Control"
 * (https://www.affectui.com/components/segmented-control, Clean preview,
 * captured 2026-10-26): a single-value selector whose light fill slides to
 * the active option, with a roving focus, an overflow scroller and touch
 * sizing. Reproduced: the `buttons`/`tray`/`underline` variants, sm/md/lg
 * sizes, the sliding indicator whose leading edge runs ahead in the direction
 * of travel, pointer drag on fine pointers, the edge fades, counts and
 * badges, the `radiogroup` and `tablist` roles with full arrow/Home/End
 * keyboard support. Deviations: colours and sizes come from the Kubecode
 * tokens and the ADR 0256 coarse-pointer convention; option labels are copy
 * the caller passes (already localized); no image-icon error masking (icons
 * are React nodes, not URLs).
 *
 * Owns selection presentation only: the values are the caller's domain
 * states. States: idle, hover, active, disabled option, whole-control
 * disabled, overflow; `#/controls` (AgentUiMatrix) demonstrates them.
 */

export interface SegmentedOption {
  value: string
  label?: string
  icon?: React.ReactNode
  /** A small neutral counter after the label. */
  count?: number
  /** A highlighted badge after the label. */
  badge?: string
  disabled?: boolean
  /** Accessible name when the label alone is not enough. */
  ariaLabel?: string
  /** For `kind="tabs"`: the id of the panel the tab controls. */
  controls?: string
}

export interface SegmentedControlProps {
  options: SegmentedOption[]
  value?: string
  defaultValue?: string
  onChange?: (value: string) => void
  size?: 'sm' | 'md' | 'lg'
  variant?: 'buttons' | 'tray' | 'underline'
  fullWidth?: boolean
  /** `radio` (default) renders a radiogroup; `tabs` renders a tablist. */
  kind?: 'radio' | 'tabs'
  disabled?: boolean
  'aria-label'?: string
  'aria-labelledby'?: string
  className?: string
}

const OVERFLOW_THRESHOLD = 1
const DRAG_DISTANCE = { mouse: 3, touch: 8 }

export function SegmentedControl({
  options,
  value,
  defaultValue,
  onChange,
  size = 'md',
  variant = 'buttons',
  fullWidth = false,
  kind = 'radio',
  disabled = false,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  className,
}: SegmentedControlProps) {
  const clean = useMemo(() => {
    const seen = new Set<string>()
    return (Array.isArray(options) ? options : []).filter(
      (option) => !option || option.value == null || seen.has(String(option.value))
        ? false
        : (seen.add(String(option.value)), true),
    )
  }, [options])

  const [internal, setInternal] = useState(() => defaultValue ?? clean.find((option) => !option.disabled)?.value)
  const active = value === undefined ? internal : value
  const root = useRef<HTMLDivElement | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)
  const track = useRef<HTMLDivElement | null>(null)
  const pill = useRef<HTMLSpanElement | null>(null)
  const dragging = useRef(false)
  const dragTimer = useRef(0)
  const previousActive = useRef<unknown>(undefined)

  const activeIndex = clean.findIndex((option) => option.value === active)
  const focusIndex = activeIndex >= 0 ? activeIndex : clean.findIndex((option) => !option.disabled)

  const select = useCallback(
    (next: string) => {
      const option = clean.find((candidate) => candidate.value === next)
      if (!option || option.disabled || disabled || next === active) return
      if (value === undefined) setInternal(next)
      onChange?.(next)
    },
    [active, clean, disabled, onChange, value],
  )

  const optionElements = useCallback(
    () => Array.from(track.current?.querySelectorAll<HTMLButtonElement>(':scope > .agx-segc__opt') ?? []),
    [],
  )

  const placePill = useCallback(
    (animate: boolean) => {
      const trackElement = track.current
      const pillElement = pill.current
      if (!trackElement || !pillElement) return
      const activeElement = trackElement.querySelector<HTMLElement>(':scope > .agx-segc__opt[data-active]')
      if (!activeElement?.offsetWidth) {
        pillElement.style.opacity = '0'
        return
      }
      let left = activeElement.offsetLeft
      let width = activeElement.offsetWidth
      if (variant === 'underline') {
        const content = activeElement.firstElementChild as HTMLElement | null
        if (content) {
          left += content.offsetLeft
          width = content.offsetWidth
        }
      }
      const cold = !pillElement.dataset.ready || (!animate && !dragging.current)
      const currentLeft = Number.parseFloat(pillElement.style.left) || 0
      if (!cold && left !== currentLeft) {
        pillElement.dataset.dir = left > currentLeft ? 'right' : 'left'
      }
      if (cold) pillElement.style.transition = 'none'
      pillElement.style.opacity = '1'
      pillElement.style.left = `${left}px`
      pillElement.style.right = `${trackElement.clientWidth - left - width}px`
      if (cold) {
        pillElement.dataset.ready = '1'
        void pillElement.offsetWidth
        pillElement.style.transition = ''
      }
    },
    [variant],
  )

  const syncOverflow = useCallback(() => {
    const scrollerElement = scroller.current
    const rootElement = root.current
    if (!scrollerElement || !rootElement) return
    const overflow = scrollerElement.scrollWidth - scrollerElement.clientWidth
    rootElement.toggleAttribute('data-overflow', overflow > OVERFLOW_THRESHOLD)
    scrollerElement.style.setProperty('--agx-segc-fade-l', scrollerElement.scrollLeft > OVERFLOW_THRESHOLD ? '24px' : '0px')
    scrollerElement.style.setProperty(
      '--agx-segc-fade-r',
      scrollerElement.scrollLeft < overflow - OVERFLOW_THRESHOLD ? '24px' : '0px',
    )
  }, [])

  const revealActive = useCallback(
    (smooth: boolean) => {
      const scrollerElement = scroller.current
      const trackElement = track.current
      const activeElement = track.current?.querySelector<HTMLElement>(':scope > .agx-segc__opt[data-active]')
      if (!scrollerElement || !trackElement || !activeElement || scrollerElement.scrollWidth <= scrollerElement.clientWidth + 1) {
        return
      }
      const left =
        trackElement.offsetLeft + activeElement.offsetLeft - (scrollerElement.clientWidth - activeElement.offsetWidth) / 2
      scrollerElement.scrollTo({ left: Math.max(0, left), behavior: smooth ? 'smooth' : 'auto' })
    },
    [],
  )

  useLayoutEffect(() => {
    const trackElement = track.current
    const scrollerElement = scroller.current
    if (!trackElement || !scrollerElement) return
    const refit = () => {
      // Equal segments: each option as wide as the widest one needs.
      const elements = optionElements()
      if (fullWidth && elements.length) {
        const widths = elements.map((element) => {
          const content = element.firstElementChild as HTMLElement | null
          const styles = getComputedStyle(element)
          return (content?.offsetWidth ?? 0) + Number.parseFloat(styles.paddingLeft) + Number.parseFloat(styles.paddingRight)
        })
        trackElement.style.setProperty('--agx-segc-min', `${Math.max(...widths)}px`)
      }
      placePill(false)
      syncOverflow()
    }
    refit()
    const frame = requestAnimationFrame(() => root.current?.setAttribute('data-ready', ''))
    let queued = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(queued)
      queued = requestAnimationFrame(refit)
    })
    observer.observe(scrollerElement)
    observer.observe(trackElement)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(queued)
      cancelAnimationFrame(frame)
    }
  }, [clean.length, fullWidth, variant, size, placePill, syncOverflow, optionElements])

  useLayoutEffect(() => {
    if (previousActive.current === active) return
    const cold = previousActive.current === undefined
    previousActive.current = active
    if (!cold) {
      dragging.current = true
      window.clearTimeout(dragTimer.current)
      dragTimer.current = window.setTimeout(() => {
        dragging.current = false
      }, 240)
    }
    placePill(!cold)
    revealActive(!cold)
    const trackElement = track.current
    if (!cold && trackElement?.contains(document.activeElement)) {
      optionElements()[focusIndex]?.focus({ preventScroll: true })
    }
  }, [active, focusIndex, placePill, revealActive, optionElements])

  useEffect(() => () => window.clearTimeout(dragTimer.current), [])

  const onKeyDown = (event: React.KeyboardEvent) => {
    const enabled = clean.filter((option) => !option.disabled)
    if (!enabled.length || disabled) return
    const previousKeys = kind === 'radio' ? ['ArrowLeft', 'ArrowUp'] : ['ArrowLeft']
    const nextKeys = kind === 'radio' ? ['ArrowRight', 'ArrowDown'] : ['ArrowRight']
    const index = enabled.findIndex((option) => option.value === active)
    let target: SegmentedOption | undefined
    if (previousKeys.includes(event.key)) target = enabled[(index - 1 + enabled.length) % enabled.length]
    else if (nextKeys.includes(event.key)) target = enabled[(index + 1) % enabled.length]
    else if (event.key === 'Home') target = enabled[0]
    else if (event.key === 'End') target = enabled[enabled.length - 1]
    if (!target) return
    event.preventDefault()
    select(target.value)
    optionElements()[clean.indexOf(target)]?.focus()
  }

  const nearestOption = (clientX: number): SegmentedOption | undefined => {
    const elements = optionElements()
    let best = -1
    let distance = Number.POSITIVE_INFINITY
    elements.forEach((element, index) => {
      const box = element.getBoundingClientRect()
      const gap = clientX < box.left ? box.left - clientX : clientX > box.right ? clientX - box.right : 0
      if (gap < distance) {
        distance = gap
        best = index
      }
    })
    return best >= 0 ? clean[best] : undefined
  }

  const pointer = useRef<{ id: number; touch: boolean; drag: boolean; x: number } | null>(null)

  const onPointerDown = (event: React.PointerEvent) => {
    if (disabled || event.button !== 0) return
    const option = nearestOption(event.clientX)
    if (!option || option.disabled) return
    const touch = event.pointerType === 'touch'
    const drag = !touch || option.value === active
    pointer.current = { id: event.pointerId, touch, drag, x: event.clientX }
    if (drag) root.current?.setAttribute('data-pressed', '')
    if (!touch) {
      select(option.value)
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // The control stays clickable without capture; drag is best effort.
      }
    }
  }

  const onPointerMove = (event: React.PointerEvent) => {
    const state = pointer.current
    if (!state || state.id !== event.pointerId) return
    const moved = Math.abs(event.clientX - state.x)
    if (!dragging.current && moved < DRAG_DISTANCE[state.touch ? 'touch' : 'mouse']) return
    dragging.current = true
    if (!state.drag) return
    const option = nearestOption(event.clientX)
    if (option && !option.disabled) select(option.value)
  }

  const endPointer = (event: React.PointerEvent) => {
    if (pointer.current?.id !== event.pointerId) return
    pointer.current = null
    root.current?.removeAttribute('data-pressed')
    window.clearTimeout(dragTimer.current)
    dragging.current = false
  }

  const asTabs = kind === 'tabs'

  return (
    <div
      ref={root}
      className={className ? `agx-segc ${className}` : 'agx-segc'}
      data-size={size}
      data-variant={variant}
      data-full={fullWidth || undefined}
      data-disabled={disabled || undefined}
    >
      <div ref={scroller} className="agx-segc__scroller" onScroll={syncOverflow}>
        <div
          ref={track}
          className="agx-segc__track"
          role={asTabs ? 'tablist' : 'radiogroup'}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-disabled={disabled || undefined}
          aria-orientation={asTabs ? 'horizontal' : undefined}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          onLostPointerCapture={endPointer}
        >
          <span ref={pill} className="agx-segc__pill" aria-hidden="true" />
          {clean.map((option, index) => {
            const isActive = index === activeIndex
            const label = option.label ?? (option.icon ? null : String(option.value))
            return (
              <button
                key={String(option.value)}
                type="button"
                className="agx-segc__opt"
                role={asTabs ? 'tab' : 'radio'}
                aria-checked={asTabs ? undefined : isActive}
                aria-selected={asTabs ? isActive : undefined}
                aria-controls={asTabs ? option.controls : undefined}
                aria-label={option.ariaLabel}
                data-active={isActive || undefined}
                disabled={option.disabled || disabled}
                tabIndex={index === focusIndex ? 0 : -1}
                onClick={() => select(option.value)}
              >
                <span className="agx-segc__content">
                  {option.icon && <span className="agx-segc__icon">{option.icon}</span>}
                  {label != null && (
                    <span className="agx-segc__label" dir="auto">
                      {label}
                    </span>
                  )}
                  {typeof option.count === 'number' && Number.isFinite(option.count) && (
                    <span className="agx-segc__count" key={option.count}>
                      {option.count.toLocaleString()}
                    </span>
                  )}
                  {option.badge != null && <span className="agx-segc__badge">{option.badge}</span>}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
