import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ShimmerBlock, ShimmerText } from './shimmer'

/**
 * ADR 0257 §7: skeleton blocks are decorative; text shimmers render their
 * real content; circle and radius variants compute their geometry.
 */
describe('Shimmer primitives', () => {
  it('renders a decorative block with numeric lengths turned into px', () => {
    const { container } = render(<ShimmerBlock width={96} height={10} radius={5} />)
    const block = container.firstElementChild as HTMLElement
    expect(block).toHaveAttribute('aria-hidden', 'true')
    expect(block.style.width).toBe('96px')
    expect(block.style.height).toBe('10px')
    expect(block.style.borderRadius).toBe('5px')
  })

  it('renders a circle from the width', () => {
    const { container } = render(<ShimmerBlock width={36} circle />)
    const block = container.firstElementChild as HTMLElement
    expect(block.style.width).toBe('36px')
    expect(block.style.height).toBe('36px')
    expect(block.style.borderRadius).toBe('50%')
  })

  it('renders shimmering text with its real content', () => {
    const { container } = render(<ShimmerText duration={1.5}>Generating summary…</ShimmerText>)
    const text = container.firstElementChild as HTMLElement
    expect(text).not.toHaveAttribute('aria-hidden')
    expect(text).toHaveTextContent('Generating summary…')
    expect(text.style.getPropertyValue('--agx-shimmer-text-dur')).toBe('1.5s')
  })
})
