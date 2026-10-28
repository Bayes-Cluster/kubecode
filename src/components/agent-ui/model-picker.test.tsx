import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AgxModelPickerOption, AgxModelPickerToggle, AgxModelPickerTrigger } from './model-picker'

/**
 * ADR 0257 §7: the trigger pill carries the glyph, the truncating name and
 * the turning chevron; option rows carry the name, the provider's own
 * description and the check; toggles carry the label and the switch. The
 * provider's config catalog stays the only content (ADR 0257 §3) — nothing
 * here fabricates a rating.
 */

describe('AgxModelPickerTrigger', () => {
  it('shows the glyph tile, the truncating name and the chevron', () => {
    render(
      <AgxModelPickerTrigger chevron={<svg data-testid="chevron" />} glyph={<i data-testid="glyph" />} name="Sonnet 5.5">
        <span>Model</span>
      </AgxModelPickerTrigger>,
    )
    const trigger = screen.getByText('Sonnet 5.5').closest('.agx-mpick__trigger') as HTMLElement
    expect(trigger).toBeInTheDocument()
    expect(trigger.querySelector('.agx-mpick__glyph')).toContainElement(screen.getByTestId('glyph'))
    expect(screen.getByText('Sonnet 5.5')).toHaveClass('agx-mpick__trigger-name')
    expect(trigger.querySelector('.agx-mpick__chevron')).toContainElement(screen.getByTestId('chevron'))
    // The trigger's own accessible label rides along.
    expect(screen.getByText('Model')).toBeInTheDocument()
  })

  it('omits the slots the host does not fill', () => {
    render(<AgxModelPickerTrigger name="Opus 5.5" />)
    const trigger = screen.getByText('Opus 5.5').closest('.agx-mpick__trigger') as HTMLElement
    expect(trigger.querySelector('.agx-mpick__glyph')).toBeNull()
    expect(trigger.querySelector('.agx-mpick__chevron')).toBeNull()
  })
})

describe('AgxModelPickerOption', () => {
  it('carries the name, the provider description and the check', () => {
    render(
      <div className="agx-mpick__option">
        <AgxModelPickerOption check={<i data-testid="check" />} description="Balanced speed and depth" name="Sonnet 5.5" />
      </div>,
    )
    expect(screen.getByText('Sonnet 5.5')).toHaveClass('agx-mpick__option-name')
    expect(screen.getByText('Balanced speed and depth')).toHaveClass('agx-mpick__option-desc')
    expect(screen.getByTestId('check')).toBeInTheDocument()
  })

  it('leaves the detail out when the provider gives none', () => {
    render(
      <div className="agx-mpick__option">
        <AgxModelPickerOption name="Haiku 5.5" />
      </div>,
    )
    expect(document.querySelector('.agx-mpick__option-desc')).toBeNull()
  })
})

describe('AgxModelPickerToggle', () => {
  it('carries the label and the decorative switch', () => {
    render(
      // The engine row (a Radix checkbox item) says checked; the toggle
      // only draws it.
      <div aria-checked="true" data-state="checked" role="menuitemcheckbox">
        <AgxModelPickerToggle label="Streaming responses" />
      </div>,
    )
    expect(screen.getByText('Streaming responses')).toHaveClass('agx-mpick__toggle-label')
    const toggle = screen.getByText('Streaming responses').closest('.agx-mpick__toggle') as HTMLElement
    const box = toggle.querySelector('.agx-mpick__switch') as HTMLElement
    expect(box).toHaveAttribute('aria-hidden', 'true')
  })
})
