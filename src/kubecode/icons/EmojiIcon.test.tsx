import { render } from '@testing-library/react'
import { Sparkles } from 'lucide-react'
import { describe, expect, it } from 'vitest'

import { EmojiIcon, EMOJI_ICON_BOX_CLASS } from './EmojiIcon'

describe('EmojiIcon', () => {
  it('renders a single emoji inside the identity box', () => {
    const { container } = render(<EmojiIcon value="🚀" />)
    const box = container.querySelector(`.${EMOJI_ICON_BOX_CLASS}`)
    expect(box).not.toBeNull()
    expect(box?.textContent).toBe('🚀')
    expect(box?.getAttribute('data-shows-emoji')).toBe('true')
  })

  it('renders compound emoji without splitting them', () => {
    const { container } = render(<EmojiIcon value="👩‍💻" />)
    expect(container.querySelector(`.${EMOJI_ICON_BOX_CLASS}`)?.textContent).toBe('👩‍💻')
  })

  it('falls back to the glyph for kebab-case legacy icon names', () => {
    const { container } = render(<EmojiIcon value="rocket-launch" />)
    const box = container.querySelector(`.${EMOJI_ICON_BOX_CLASS}`)
    expect(box?.getAttribute('data-shows-emoji')).toBe('false')
    expect(box?.querySelector('svg')).not.toBeNull()
    expect(box?.textContent).not.toContain('rocket-launch')
  })

  it('falls back for empty and missing values', () => {
    for (const value of [undefined, null, '', '   ']) {
      const { container } = render(<EmojiIcon value={value} />)
      const box = container.querySelector(`.${EMOJI_ICON_BOX_CLASS}`)
      expect(box?.getAttribute('data-shows-emoji')).toBe('false')
      expect(box?.querySelector('svg')).not.toBeNull()
    }
  })

  it('sizes the fallback svg at the 20px toolbar tier', () => {
    const { container } = render(<EmojiIcon value={null} />)
    const svg = container.querySelector(`.${EMOJI_ICON_BOX_CLASS} svg`)
    expect(svg?.getAttribute('width')).toBe('20')
    expect(svg?.getAttribute('height')).toBe('20')
  })

  it('accepts a custom fallback glyph', () => {
    const { container } = render(<EmojiIcon value="not-an-emoji" fallback={Sparkles} />)
    const svg = container.querySelector(`.${EMOJI_ICON_BOX_CLASS} svg`)
    expect(svg?.getAttribute('data-icon-role')).toBeNull()
    expect(svg).not.toBeNull()
  })

  it('is decorative without a label and an image with one', () => {
    const decorative = render(<EmojiIcon value="🚀" />).container.querySelector(`.${EMOJI_ICON_BOX_CLASS}`)
    expect(decorative?.getAttribute('aria-hidden')).toBe('true')

    const labeled = render(<EmojiIcon value="🚀" label="Launch checklist" />).container.querySelector(
      `.${EMOJI_ICON_BOX_CLASS}`,
    )
    expect(labeled?.getAttribute('role')).toBe('img')
    expect(labeled?.getAttribute('aria-label')).toBe('Launch checklist')
    expect(labeled?.getAttribute('aria-hidden')).toBeNull()
  })

  it('appends the custom className after the box class', () => {
    const { container } = render(<EmojiIcon value="🚀" className="extra-class" />)
    const box = container.querySelector(`.${EMOJI_ICON_BOX_CLASS}`)
    expect(box?.classList.contains('extra-class')).toBe(true)
  })
})
