import { useId, type ReactNode } from 'react'

import './filter-menu.css'

/**
 * ADR 0257, adapting the affectUI "Filter Menu"
 * (https://www.affectui.com/components/filter-menu, Clean preview, captured
 * 2026-10-29) as the one filter presentation for the boards — Work (#284),
 * Tasks (#283). Reproduced: the title with the ghost clear-all, the active
 * selections as chips on one line, the collapsible option groups with their
 * live counts and a picked summary, the checkbox options whose check draws
 * itself in, and the keyboard hints at the foot. Deviations: the chip line
 * scrolls sideways instead of folding into a popover (the boards carry a
 * handful of selections, not tens); group counts, options and what picking
 * them does are the adapter's data and semantics — nothing here filters by
 * itself. `#283` mounts this for Tasks through the same parts.
 *
 * States: `#/controls` (AgentUiMatrix) shows the card with a group open,
 * a picked option and the chips row.
 */

/** The filter card: title, clear-all, the chips row and the groups. */
export function AgxFilterMenu({
  title,
  clearLabel,
  onClear,
  clearDisabled = false,
  chips,
  children,
  hints,
  className,
}: {
  title: ReactNode
  /** The ghost clear-all; without a label there is no clear control. */
  clearLabel?: ReactNode
  onClear?: () => void
  clearDisabled?: boolean
  /** The active selections, in the caller's order. */
  chips?: ReactNode
  /** The option groups. */
  children?: ReactNode
  /** The keyboard hints row, if the host shows one. */
  hints?: ReactNode
  className?: string
}) {
  return (
    <section className={className ? `agx-filt ${className}` : 'agx-filt'}>
      <header className="agx-filt__head">
        <h3 className="agx-filt__title">{title}</h3>
        {clearLabel !== undefined && onClear !== undefined && (
          <button disabled={clearDisabled} type="button" className="agx-filt__clear" onClick={onClear}>
            {clearLabel}
          </button>
        )}
      </header>
      {chips !== undefined && chips !== null && <div className="agx-filt__chips">{chips}</div>}
      {children !== undefined && children !== null && <div className="agx-filt__groups">{children}</div>}
      {hints !== undefined && hints !== null && <footer className="agx-filt__hints">{hints}</footer>}
    </section>
  )
}

/** One active-selection chip; the caller lines them up in `chips`. */
export function AgxFilterChip({ children }: { children: ReactNode }) {
  return <span className="agx-filt__chip">{children}</span>
}

/** One collapsible option group: the live count and the picked summary. */
export function AgxFilterGroup({
  label,
  count,
  picked,
  open,
  onOpenChange,
  children,
}: {
  label: ReactNode
  /** How many options the group holds, said by the adapter's data. */
  count?: ReactNode
  /** What is picked, as the caller words it. */
  picked?: ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  children?: ReactNode
}) {
  const panelId = useId()
  return (
    <div className="agx-filt__group" data-open={open ? '' : undefined}>
      <button
        aria-controls={panelId}
        aria-expanded={open}
        className="agx-filt__group-head"
        type="button"
        onClick={() => onOpenChange(!open)}
      >
        <svg aria-hidden="true" className="agx-filt__chevron" fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.1" viewBox="0 0 16 16" width="16">
          <path d="m6 4 4 4-4 4" />
        </svg>
        <span className="agx-filt__group-label">{label}</span>
        {count !== undefined && count !== null && <span className="agx-filt__group-count">{count}</span>}
        {picked !== undefined && picked !== null && <span className="agx-filt__group-picked">{picked}</span>}
      </button>
      <div className="agx-filt__panel" id={panelId}>
        <div className="agx-filt__panel-inner">{children}</div>
      </div>
    </div>
  )
}

/** One checkbox option. The caller owns what checking it does. */
export function AgxFilterOption({
  checked,
  label,
  disabled = false,
  onToggle,
}: {
  checked: boolean
  label: ReactNode
  disabled?: boolean
  onToggle: () => void
}) {
  return (
    <button
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      className="agx-filt__option"
      role="checkbox"
      type="button"
      onClick={() => {
        if (!disabled) onToggle()
      }}
    >
      <span aria-hidden="true" className="agx-filt__box">
        <svg viewBox="0 0 12 12">
          <path d="m2.5 6.5 2.5 2.5 4.5-5.5" />
        </svg>
      </span>
      <span className="agx-filt__option-label">{label}</span>
    </button>
  )
}
