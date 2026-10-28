import type { ReactNode } from 'react'

import './model-picker.css'

/**
 * ADR 0257, adapting the affectUI "Model Picker"
 * (https://www.affectui.com/components/model-picker, Clean preview,
 * captured 2026-10-28) onto the session control menu, whose catalog is the
 * provider's own config options and whose Radix menu stays the engine
 * (ADR 0257 §2; slice E1's terms: selection/detail/effort disclosure over
 * the real catalog). Reproduced: the quiet trigger pill with the glyph
 * tile and the turning chevron, option rows with the chosen check and the
 * quiet description (the detail), and the switch toggles for boolean
 * options; effort-style selects with a handful of choices present as
 * inline segmented rows (`SegmentedControl`) instead of sub-menus.
 * Deviations: no capability meters, no prices, no hosted-provider marks —
 * the reference's fabricated ratings have no honest counterpart in the
 * provider catalog (ADR 0257 §3).
 */

/** The quiet trigger pill; the caller fills it through the slots. */
export function AgxModelPickerTrigger({
  glyph,
  name,
  chevron,
  children,
}: {
  /** The provider/agent glyph, shown on its tile. */
  glyph?: ReactNode
  /** The current value's name, truncated. */
  name: ReactNode
  /** The turning chevron, if the host shows one. */
  chevron?: ReactNode
  /** Anything before the name: the trigger's own label for assistive tech. */
  children?: ReactNode
}) {
  return (
    <span className="agx-mpick__trigger">
      {children}
      {glyph !== undefined && glyph !== null && (
        <span aria-hidden="true" className="agx-mpick__glyph">
          {glyph}
        </span>
      )}
      <span className="agx-mpick__trigger-name">{name}</span>
      {chevron !== undefined && chevron !== null && (
        <span aria-hidden="true" className="agx-mpick__chevron">
          {chevron}
        </span>
      )}
    </span>
  )
}

/** One selectable option: the name, the quiet detail, the chosen check. */
export function AgxModelPickerOption({
  name,
  description,
  check,
}: {
  name: ReactNode
  /** The provider's own description of the option, if it gives one. */
  description?: ReactNode
  /** The chosen check, if the caller draws it (the row knows selection). */
  check?: ReactNode
}) {
  return (
    <>
      <span className="agx-mpick__option">
        <span className="agx-mpick__option-text">
          <span className="agx-mpick__option-name" dir="auto">
            {name}
          </span>
          {description !== undefined && description !== null && (
            <span className="agx-mpick__option-desc" dir="auto">
              {description}
            </span>
          )}
        </span>
        {check}
      </span>
    </>
  )
}

/** A boolean option: the label and the switch. */
export function AgxModelPickerToggle({
  label,
  children,
}: {
  label: ReactNode
  /** The switch state box, drawn by the caller's checked row. */
  children?: ReactNode
}) {
  return (
    <span className="agx-mpick__toggle">
      <span className="agx-mpick__toggle-label">{label}</span>
      <span aria-hidden="true" className="agx-mpick__switch" />
      {children}
    </span>
  )
}
