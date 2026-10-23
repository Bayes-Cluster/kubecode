import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { RouteOpening } from './RouteOpening'

describe('RouteOpening', () => {
  it('announces the place being opened once, with an official Spinner hidden from assistive technology', () => {
    render(<RouteOpening label="Opening Workspace…" />)
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Opening Workspace…')
    expect(status).toHaveAttribute('data-slot', 'empty')
    expect(status.querySelector('svg.animate-spin')).toHaveAttribute('aria-hidden', 'true')
  })
})
