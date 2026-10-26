import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import './thinking-loader.css'

/**
 * ADR 0257, recreating the affectUI "Thinking Loader"
 * (https://www.affectui.com/components/thinking-loader, Clean preview,
 * captured 2026-10-26): a status pill whose eight rays fade in sequence (it
 * turns without rotating), whose label box glides to each incoming label and
 * rolls the old one out, and whose icon morphs into a drawn check when done.
 * Reproduced: the ray spinner, the label roll and width glide, the shine
 * sweep, the sm/md and pill/plain forms, the `role="status"` announcement.
 * Deviations: colours come from the Kubecode tokens; phases and the done
 * label always arrive through `label`/`doneLabel` from real domain events —
 * the demo's auto-advancing phase timer and elapsed-time formatting are not
 * part of the component, so nothing announced is invented here and the
 * announcement is event-based (ADR 0257 §5).
 *
 * States: running (label changes), done (`doneLabel`), narrow (`data-cut`
 * truncation); `#/controls` (AgentUiMatrix) demonstrates them.
 */

const RAYS = [0, 1, 2, 3, 4, 5, 6, 7]

export interface ThinkingLoaderProps {
  /** The current phase, from a real event. Localized by the caller. */
  label: string
  /** Shown instead of `label` once the run finished. Localized by the caller. */
  doneLabel?: string
  done?: boolean
  size?: 'sm' | 'md'
  variant?: 'pill' | 'plain'
  className?: string
}

interface Roll {
  key: number
  text: string
}

export function ThinkingLoader({
  label,
  doneLabel,
  done = false,
  size = 'md',
  variant = 'pill',
  className,
}: ThinkingLoaderProps) {
  const doneText = done ? (doneLabel ?? label) : label
  const [current, setCurrent] = useState<Roll>({ key: 0, text: doneText })
  const [ghost, setGhost] = useState<Roll | null>(null)
  const root = useRef<HTMLSpanElement | null>(null)
  const box = useRef<HTMLSpanElement | null>(null)
  const measured = useRef<HTMLSpanElement | null>(null)
  const sized = useRef(false)
  const ghostTimer = useRef(0)

  if (doneText !== current.text) {
    setGhost(current)
    setCurrent({ key: current.key + 1, text: doneText })
  }

  // Width glide: the box takes the incoming label's measured width; the CSS
  // transition carries it from the previous width. The first commit sets the
  // width without a transition so nothing glides on mount. The available
  // width comes from the pill's containing block, measured with rects so the
  // answer does not depend on which ancestor happens to be positioned; a
  // narrow container truncates instead of overflowing (data-cut).
  const fit = (animateFirst: boolean) => {
    const span = measured.current
    const element = box.current
    const outer = root.current?.parentElement
    if (!span || !element) return
    if (!animateFirst && !sized.current) {
      element.style.transition = 'none'
    }
    const needed = span.scrollWidth + 1
    const available = outer
      ? Math.floor(
          outer.clientWidth -
            Number.parseFloat(getComputedStyle(outer).paddingLeft) -
            Number.parseFloat(getComputedStyle(outer).paddingRight) -
            (element.getBoundingClientRect().left - outer.getBoundingClientRect().left),
        )
      : needed
    const cut = needed > available && available > 0
    element.toggleAttribute('data-cut', cut)
    element.style.width = `${cut ? Math.max(available, 0) : needed}px`
    if (!sized.current) {
      void element.getBoundingClientRect()
      element.style.transition = ''
      sized.current = true
    }
  }

  useLayoutEffect(() => {
    fit(false)
  }, [current.key])

  // Re-derive the truncation when the surroundings resize.
  useEffect(() => {
    const outer = root.current?.parentElement
    if (!outer || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (sized.current) fit(true)
    })
    observer.observe(outer)
    return () => observer.disconnect()
  }, [])

  useEffect(() => () => window.clearTimeout(ghostTimer.current), [])

  // Safety: drop the ghost even if its animation is interrupted.
  useEffect(() => {
    if (!ghost) return
    window.clearTimeout(ghostTimer.current)
    ghostTimer.current = window.setTimeout(() => setGhost(null), 600)
    return () => window.clearTimeout(ghostTimer.current)
  }, [ghost])

  return (
    <span
      ref={root}
      className={className ? `agx-thinking ${className}` : 'agx-thinking'}
      data-size={size}
      data-variant={variant}
      data-done={done || undefined}
      role="status"
    >
      <span className="agx-thinking__icon" aria-hidden="true">
        <svg className="agx-thinking__spinner" viewBox="0 0 16 16">
          {RAYS.map((ray) => (
            <line
              key={ray}
              x1="8"
              y1="1.75"
              x2="8"
              y2="4.75"
              transform={`rotate(${ray * 45} 8 8)`}
              style={{ animationDelay: `${(ray - RAYS.length) * 100}ms` }}
            />
          ))}
        </svg>
        <svg className="agx-thinking__check" viewBox="0 0 16 16">
          <path d="M3.5 8.4 6.6 11.3 12.5 4.9" pathLength={1} />
        </svg>
      </span>
      <span ref={box} className="agx-thinking__text">
        {ghost && (
          <span
            key={ghost.key}
            className="agx-thinking__label agx-thinking__label--out"
            aria-hidden="true"
            onAnimationEnd={() => setGhost(null)}
          >
            {ghost.text}
          </span>
        )}
        <span
          key={current.key}
          ref={measured}
          className={`agx-thinking__label${current.key > 0 ? ' agx-thinking__label--in' : ''}${
            done ? '' : ' agx-thinking__shine'
          }`}
          data-text={current.text}
          dir="auto"
        >
          {current.text}
        </span>
      </span>
    </span>
  )
}
