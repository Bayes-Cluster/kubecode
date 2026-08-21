import { render, screen } from '@testing-library/react'
import { Check, Square } from 'lucide-react'
import { describe, expect, it } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'

import { Icon } from './Icon'
import { ICON_SIZES } from './index'

function renderIcon(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

describe('Icon', () => {
  it('renders the source svg as the root element', () => {
    const { container } = renderIcon(<Icon source={Square} role="control" />)
    const root = container.firstElementChild
    expect(root?.tagName.toLowerCase()).toBe('svg')
    expect(root?.getAttribute('data-icon-role')).toBe('control')
  })

  it('marks unlabeled icons as decorative', () => {
    const { container } = renderIcon(<Icon source={Square} role="navigation" />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
    expect(svg?.getAttribute('aria-label')).toBeNull()
    expect(svg?.getAttribute('role')).toBeNull()
  })

  it('labels icons as images and exposes the label as tooltip content', () => {
    renderIcon(<Icon source={Check} role="command" label="Approve plan" />)
    const svg = screen.getByRole('img', { name: 'Approve plan' })
    expect(svg.getAttribute('aria-label')).toBe('Approve plan')
    expect(svg.getAttribute('aria-hidden')).toBeNull()
  })

  it('keeps the svg as the tooltip trigger root', () => {
    const { container } = renderIcon(<Icon source={Check} role="command" label="Approve" />)
    // asChild means the trigger is the svg itself, not a wrapper element.
    expect(container.firstElementChild?.tagName.toLowerCase()).not.toBe('button')
    expect(container.querySelectorAll('svg')).toHaveLength(1)
  })

  it.each(Object.entries(ICON_SIZES) as [keyof typeof ICON_SIZES, number][])(
    'sizes the %s tier at %d pixels',
    (tier, pixels) => {
      const { container } = renderIcon(<Icon source={Square} role="control" size={tier} />)
      const svg = container.querySelector('svg')
      expect(svg?.getAttribute('width')).toBe(String(pixels))
      expect(svg?.getAttribute('height')).toBe(String(pixels))
    },
  )

  it('defaults the status role to the 12px tier', () => {
    const { container } = renderIcon(<Icon source={Square} role="status" />)
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('12')
  })

  it('forwards className to the source svg', () => {
    const { container } = renderIcon(
      <Icon source={Square} role="control" className="kubecode-toolbar-button-icon" />,
    )
    expect(container.querySelector('svg')?.classList.contains('kubecode-toolbar-button-icon')).toBe(true)
  })
})
