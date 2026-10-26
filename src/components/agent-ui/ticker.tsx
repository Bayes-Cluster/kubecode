import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { prefersReducedMotion } from '@/lib/reducedMotion'

import './ticker.css'

/**
 * ADR 0257, recreating the affectUI "Number Ticker" motion
 * (https://www.affectui.com/motion/number-ticker, Clean preview, captured
 * 2026-10-26): digit columns roll to the new value on an authoritative
 * update, taking the shortest path, with tabular figures. Reproduced: the
 * per-place rolling columns, the quart ease-out, the enter animation for new
 * columns, the screen-reader value, the IntersectionObserver gate and the
 * instant reduced-motion settle. Deviations: colours come from the Kubecode
 * tokens (the ticker inherits its text colour); the demo's revenue-card
 * fixture is not part of the component.
 *
 * The value must come from real data — the component never invents updates.
 * States: demonstrated in `#/controls` (AgentUiMatrix, settled and updating).
 */

interface Cell {
  key: string
  digit?: number
  char?: string
}

const EASE_OUT_QUART = (t: number): number => 1 - (1 - t) ** 4
const WRAP = (digit: number): number => ((digit % 10) + 10) % 10
const STACK = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0]

/** Split a formatted value into cells; digits are keyed by place from the
 * right, so a column keeps its identity while the value grows. */
function splitCells(text: string): Cell[] {
  const cells: Cell[] = []
  let digit = 0
  let other = 0
  for (const char of Array.from(text).reverse()) {
    if (char >= '0' && char <= '9') {
      cells.unshift({ key: `d${digit++}`, digit: Number(char) })
    } else {
      cells.unshift({ key: `s${other++}`, char })
    }
  }
  return cells
}

function applyPosition(element: HTMLElement | null | undefined, position: number) {
  element?.style.setProperty('transform', `translateY(${(-WRAP(position) / 11) * 100}%)`)
}

export interface TickerProps {
  value: number
  format?: Intl.NumberFormatOptions
  locale?: string
  duration?: number
  /** Delay after the ticker first becomes visible, in ms. */
  delay?: number
  className?: string
}

export function Ticker({
  value,
  format,
  locale,
  duration = 900,
  delay = 0,
  className,
}: TickerProps) {
  const text = useMemo(
    () => new Intl.NumberFormat(locale, format).format(value),
    [value, locale, format],
  )
  const cells = useMemo(() => splitCells(text), [text])

  // Per-column animation state, keyed by place. Positions live in refs; the
  // rAF loop writes transforms directly so a value change never re-renders.
  const positions = useRef(new Map<string, number>())
  const columns = useRef(new Map<string, HTMLElement | null>())
  const frame = useRef(0)
  const previous = useRef(value)
  const upward = useRef(true)
  // Without IntersectionObserver (a very old engine) the ticker starts at
  // once; there is nothing to gate it on.
  const [started, setStarted] = useState(() => typeof IntersectionObserver === 'undefined')
  const root = useRef<HTMLSpanElement | null>(null)

  // Columns that appear after the first commit get the enter animation. The
  // flag flips in a layout effect after the first commit, and ref callbacks
  // (which run at commit time, not during render) read it.
  const committed = useRef(false)
  useLayoutEffect(() => {
    committed.current = true
  }, [])

  useEffect(() => {
    const element = root.current
    if (!element || started) return
    let timer = 0
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return
        observer.disconnect()
        timer = window.setTimeout(() => setStarted(true), delay)
      },
      { threshold: 0.3 },
    )
    observer.observe(element)
    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
    }
  }, [delay, started])

  useEffect(() => {
    if (!started) return
    upward.current = value >= previous.current
    previous.current = value

    if (prefersReducedMotion()) {
      for (const cell of cells) {
        if (cell.digit !== undefined) positions.current.set(cell.key, cell.digit)
      }
      for (const [key, column] of columns.current) {
        applyPosition(column, positions.current.get(key) ?? 0)
      }
      return
    }

    const from = new Map<string, number>()
    const to = new Map<string, number>()
    for (const cell of cells) {
      if (cell.digit === undefined) continue
      const current = positions.current.get(cell.key) ?? 0
      const target = cell.digit
      const step = upward.current ? WRAP(target - current) : -WRAP(current - target)
      from.set(cell.key, current)
      to.set(cell.key, current + step)
    }
    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const eased = EASE_OUT_QUART(t)
      for (const [key, origin] of from) {
        const position = origin + ((to.get(key) ?? origin) - origin) * eased
        positions.current.set(key, position)
        applyPosition(columns.current.get(key), position)
      }
      if (t < 1) frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame.current)
  }, [cells, started, value, duration])

  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current)
      columns.current.clear()
      positions.current.clear()
    },
    [],
  )

  return (
    <span ref={root} className={className ? `agx-ticker ${className}` : 'agx-ticker'} aria-live="polite">
      <span className="agx-ticker__sr">{text}</span>
      <span className="agx-ticker__track" aria-hidden="true">
        {cells.map((cell) =>
          cell.digit !== undefined ? (
            <span
              key={cell.key}
              className="agx-ticker__col"
              ref={(element) => {
                // A column mounted after the first commit is new: the value
                // grew. The enter animation marks it once.
                if (element && committed.current) element.setAttribute('data-enter', '')
              }}
            >
              <span
                className="agx-ticker__stack"
                ref={(element) => {
                  columns.current.set(cell.key, element)
                  applyPosition(element, positions.current.get(cell.key) ?? cell.digit ?? 0)
                  if (!element) columns.current.delete(cell.key)
                }}
              >
                {STACK.map((digit, index) => (
                  <span key={index} className="agx-ticker__cell">
                    {digit}
                  </span>
                ))}
              </span>
            </span>
          ) : (
            <span key={cell.key} className="agx-ticker__static">
              {cell.char}
            </span>
          ),
        )}
      </span>
    </span>
  )
}
