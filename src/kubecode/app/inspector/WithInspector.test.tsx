import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { WithInspector } from './WithInspector'

describe('WithInspector', () => {
  it('keeps the view mounted under an open inspector and says how the inspector is shown', () => {
    const view = render(
      <WithInspector inspector={<aside aria-label="Task details" />} presentation="screen">
        <input aria-label="filter" defaultValue="pruning" />
      </WithInspector>,
    )
    const host = view.container.firstElementChild as HTMLElement
    expect(host).toHaveAttribute('data-detail', 'true')
    expect(host).toHaveAttribute('data-inspector-layout', 'screen')
    expect(screen.getByRole('complementary', { name: 'Task details' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'filter' })).toHaveValue('pruning')

    view.rerender(
      <WithInspector inspector={null} presentation="side">
        <input aria-label="filter" defaultValue="pruning" />
      </WithInspector>,
    )
    expect(host).toHaveAttribute('data-detail', 'false')
    expect(host).toHaveAttribute('data-inspector-layout', 'side')
    expect(screen.getByRole('textbox', { name: 'filter' })).toHaveValue('pruning')
  })
})
