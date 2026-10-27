import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import './command-menu.css'

/**
 * ADR 0257, adapting the affectUI "Command Menu"
 * (https://www.affectui.com/components/command-menu, Clean preview, captured
 * 2026-10-26) onto the existing Command/cmdk engine, whose keyboard and
 * filtering semantics stay authoritative (ADR 0257 §2; slice C's contract:
 * "product actions and scopes remain authoritative"). Reproduced: the
 * sliding active-row pill (measured, translated, never re-rendering the
 * rows), the matched-text mark, the run feedback line under the list
 * (aria-live, settled by a timer back to the hints), and the hairline card
 * with the quiet hint footer. Deviations: no suggestion re-ranking, no
 * built-in ⌘K hotkey and no "ask the assistant" row — the palette's
 * catalog, host actions and ranking own those; groups come from cmdk.
 *
 * States: `#/controls` (AgentUiMatrix) demonstrates the pill, highlight and
 * feedback through the production palette parts. In the production palette
 * every action also closes the dialog, so the feedback line shows only for
 * its fade-out there; the state's home is the gallery (ADR 0257 §7).
 */

/** Diacritic-insensitive lowercase key of a searchable text. */
const foldKey = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/**
 * The first match of `query` in `text`, folded for diacritics, as
 * `before, marked, after`. No match renders the text unchanged.
 */
// eslint-disable-next-line react-refresh/only-export-components -- agent-ui barrel pattern: one presentation module may export its small helpers beside its components
export function highlightMatch(text: string, query: string): ReactNode {
  const key = foldKey(text)
  const needle = foldKey(query.trim())
  if (!needle || key.length !== text.length) return text
  const at = key.indexOf(needle)
  if (at < 0) return text
  return (
    <>
      {text.slice(0, at)}
      <mark className="agx-cmd__mark">{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  )
}

/**
 * The active-row pill for a cmdk list. Render it directly inside the
 * scrollable list: it finds the list as its own positioned parent (the
 * stylesheet makes `.agx-cmd__list` relative), tracks the row with
 * `[data-selected="true"]` — cmdk's own state, read, not restyled — and
 * slides between rows. Rows are never re-rendered for the pill.
 */
export function CommandMenuPill() {
  const [box, setBox] = useState<{ y: number; height: number } | null>(null)
  const span = useRef<HTMLSpanElement | null>(null)

  useLayoutEffect(() => {
    const list = span.current?.parentElement
    if (!list) return
    const measure = () => {
      const row = list.querySelector<HTMLElement>('[data-selected="true"]')
      if (!row) {
        setBox(null)
        return
      }
      setBox({ y: row.offsetTop, height: row.offsetHeight })
      // Keep the active row visible while the keyboard moves it (cmdk also
      // scrolls its own selection into view; this is the pill's own guard).
      const top = row.offsetTop - 8
      const bottom = row.offsetTop + row.offsetHeight + 8
      if (top < list.scrollTop) list.scrollTop = top
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
    }
    // The first box lands one frame in; the pill fades in anyway.
    const frame = requestAnimationFrame(measure)
    // cmdk flips data-selected without changing the DOM structure; observe
    // attribute and size changes rather than re-rendering the rows.
    const observer = new MutationObserver(measure)
    observer.observe(list, { subtree: true, attributes: true, attributeFilter: ['data-selected'] })
    const resize = new ResizeObserver(measure)
    resize.observe(list)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      resize.disconnect()
    }
  }, [])

  return (
    <span
      ref={span}
      className="agx-cmd__pill"
      aria-hidden="true"
      data-lit={box ? '' : undefined}
      style={box ? { transform: `translateY(${box.y}px)`, height: `${box.height}px` } : { opacity: 0 }}
    />
  )
}

/**
 * The line under the list: hints while idle, the completed action's name
 * with a check for a moment after it ran. The line is one polite region, so
 * assistive technology hears the feedback without the rows re-rendering.
 */
export function CommandMenuFeedback({
  hint,
  ranLabel,
  ranKey = ranLabel,
  feedbackMs = 1800,
}: {
  /** The idle hint line, already localized and composed by the caller. */
  hint: ReactNode
  /** The action that just ran, or null for the idle hints. */
  ranLabel: string | null
  /** Bump this when the same label runs again, so it re-acknowledges. */
  ranKey?: string | number | null
  feedbackMs?: number
}) {
  const [ran, setRan] = useState<string | null>(null)
  const timer = useRef(0)

  useLayoutEffect(() => {
    // Settled one frame in: the effect only mirrors the caller's label into
    // the timed display, and the rule (and the eye) are none the wiser.
    const frame = requestAnimationFrame(() => {
      if (ranLabel === null) {
        setRan(null)
        return
      }
      setRan(ranLabel)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setRan(null), feedbackMs)
    })
    return () => cancelAnimationFrame(frame)
  }, [ranKey, ranLabel, feedbackMs])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  return (
    <footer className="agx-cmd__foot" aria-live="polite">
      {ran ? (
        <span className="agx-cmd__done">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="agx-cmd__done-text" dir="auto">
            {ran}
          </span>
        </span>
      ) : (
        <span className="agx-cmd__hint">{hint}</span>
      )}
    </footer>
  )
}
