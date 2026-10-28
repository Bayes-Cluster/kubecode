import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import './picker.css'

/**
 * ADR 0257, adapting the affectUI "Combobox"
 * (https://www.affectui.com/components/combobox, Clean preview, captured
 * 2026-10-28) onto the existing picker engines — the mention picker's cmdk
 * list, the command menu and the capability/context menus — whose
 * selection, filtering and keyboard semantics stay authoritative (ADR 0257
 * §2). Reproduced: the grouped results with their uppercase labels, the
 * light fill that glides to the active row without re-rendering the rows,
 * the matched-text mark, the check that pops in on the chosen row, the
 * count/keys footer, and the empty state. Deviations: no create-row and no
 * avatar column of their own — whether an option may be created, and who
 * an option depicts, belong to the caller's catalog.
 *
 * States: `#/controls` (AgentUiMatrix) shows the grouped list, the gliding
 * fill, the chosen check and the footer as a static fixture; the production
 * pickers exercise the same parts live.
 */

/**
 * The active-row fill for a list picker. Render it directly inside the
 * scrollable list (`.agx-pick__list` is its positioned parent); it tracks
 * rows by `selector` — cmdk's `[data-selected="true"]` or Radix menus'
 * `[data-highlighted]`, read, not restyled — and slides between them. The
 * rows never re-render for the fill.
 */
export function AgxPickerFill({
  selector = '[data-selected="true"], [aria-selected="true"]',
}: {
  selector?: string
}) {
  const [box, setBox] = useState<{ y: number; height: number } | null>(null)
  const span = useRef<HTMLSpanElement | null>(null)

  useLayoutEffect(() => {
    const list = span.current?.parentElement
    if (!list) return
    const measure = () => {
      const row = list.querySelector<HTMLElement>(selector)
      if (!row) {
        setBox(null)
        return
      }
      setBox({ y: row.offsetTop, height: row.offsetHeight })
      // Keep the active row visible while the keyboard moves it.
      const top = row.offsetTop - 8
      const bottom = row.offsetTop + row.offsetHeight + 8
      if (top < list.scrollTop) list.scrollTop = top
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
    }
    // The first box lands one frame in; the fill fades in anyway.
    const frame = requestAnimationFrame(measure)
    // Selection flips attributes without changing the DOM structure;
    // observe attribute and childList changes rather than re-rendering
    // rows (a disjoint candidate set swaps the selected node itself).
    const attributes = [...selector.matchAll(/\[([a-z-]+)(?:=[^\]]*)?\]/gi)].map((match) => match[1])
    const observer = new MutationObserver(measure)
    observer.observe(list, {
      attributeFilter: attributes.length > 0 ? attributes : ['data-selected', 'aria-selected'],
      attributes: true,
      childList: true,
      subtree: true,
    })
    const resize = new ResizeObserver(measure)
    resize.observe(list)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      resize.disconnect()
    }
  }, [selector])

  return (
    <span
      ref={span}
      aria-hidden="true"
      className="agx-pick__fill"
      data-lit={box ? '' : undefined}
      style={box ? { transform: `translateY(${box.y}px)`, height: `${box.height}px` } : undefined}
    />
  )
}

/** A grouped section of results, with the reference's uppercase label. */
export function AgxPickerGroup({
  label,
  children,
}: {
  label: ReactNode
  children: ReactNode
}) {
  return (
    <div className="agx-pick__group" role="group">
      <div className="agx-pick__group-label">{label}</div>
      {children}
    </div>
  )
}

/** One option row: the leading identity, the name, an optional hint, and
 * the chosen check. */
export function AgxPickerRow({
  name,
  hint,
  check = true,
  children,
}: {
  /** The option's name — the caller marks matches with `highlightMatch`. */
  name: ReactNode
  /** The quiet second line (a handle, a description), if the option has one. */
  hint?: ReactNode
  /** Rows whose selection is said by the fill alone (actions, not choices)
   * draw no check. */
  check?: boolean
  /** Anything before the text: an avatar or glyph, as the reference leads. */
  children?: ReactNode
}) {
  return (
    <>
      {children}
      <span className="agx-pick__text">
        <span className="agx-pick__name" dir="auto">
          {name}
        </span>
        {hint !== undefined && hint !== null && (
          <span className="agx-pick__hint" dir="auto">
            {hint}
          </span>
        )}
      </span>
      {check && (
        <svg aria-hidden="true" className="agx-pick__check" viewBox="0 0 16 16">
          <path
            d="m3.5 8.5 3 3 6-7"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
          />
        </svg>
      )}
    </>
  )
}

/** The footer: the visible count on the left, the key hints on the right. */
export function AgxPickerFoot({
  count,
  keys,
}: {
  /** How many options the list holds, said for everyone. */
  count?: ReactNode
  /** The key hints as ready-made `kbd` elements, if the host shows them. */
  keys?: ReactNode
}) {
  if (count === undefined && keys === undefined) return null
  return (
    <footer className="agx-pick__foot">
      {count !== undefined && (
        <span className="agx-pick__count" role="status">
          {count}
        </span>
      )}
      {keys !== undefined && <span className="agx-pick__keys">{keys}</span>}
    </footer>
  )
}

/** The empty state: what the caller says when nothing matches. */
export function AgxPickerEmpty({ children }: { children: ReactNode }) {
  return <div className="agx-pick__empty">{children}</div>
}
