import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SegmentedControl, type SegmentedOption } from './segmented-control'

/**
 * ADR 0257 §7: one value at a time, full keyboard support with a roving
 * focus, disabled options skipped, both the radiogroup and the tablist
 * contract, and a repeated selection that changes nothing.
 */

const OPTIONS: SegmentedOption[] = [
  { value: 'list', label: 'List' },
  { value: 'board', label: 'Board' },
  { value: 'chart', label: 'Chart', disabled: true },
]

function renderControl(overrides: Partial<Parameters<typeof SegmentedControl>[0]> = {}) {
  const onChange = vi.fn()
  const view = render(
    <SegmentedControl options={OPTIONS} aria-label="Layout" onChange={onChange} {...overrides} />,
  )
  return { ...view, onChange }
}

/** jsdom lays nothing out; the indicator only moves between real boxes. */
function stubGeometryIn(container: HTMLElement, name: string, left: number) {
  const element = screen.getByRole('radio', { name }) as HTMLElement
  void container
  Object.defineProperty(element, 'offsetLeft', { value: left, configurable: true })
  Object.defineProperty(element, 'offsetWidth', { value: 60, configurable: true })
  Object.defineProperty(element, 'offsetHeight', { value: 28, configurable: true })
  return element
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SegmentedControl', () => {
  it('renders a radiogroup with exactly one checked option', () => {
    renderControl({ defaultValue: 'board' })
    expect(screen.getByRole('radiogroup', { name: 'Layout' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Board' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'List' })).toHaveAttribute('aria-checked', 'false')
  })

  it('selects by click and ignores a repeated selection', () => {
    const { onChange } = renderControl({ defaultValue: 'list' })
    fireEvent.click(screen.getByRole('radio', { name: 'Board' }))
    expect(onChange).toHaveBeenCalledWith('board')
    onChange.mockClear()
    fireEvent.click(screen.getByRole('radio', { name: 'Board' }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('moves with the arrow keys and Home/End, skipping disabled options', () => {
    const { onChange } = renderControl({ defaultValue: 'board' })
    const group = screen.getByRole('radiogroup', { name: 'Layout' })
    fireEvent.keyDown(group, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('list')
    fireEvent.keyDown(group, { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('board')
    fireEvent.keyDown(group, { key: 'Home' })
    expect(onChange).toHaveBeenLastCalledWith('list')
    fireEvent.keyDown(group, { key: 'End' })
    expect(onChange).toHaveBeenLastCalledWith('board')
  })

  it('keeps a roving tabindex on the active option', () => {
    renderControl({ defaultValue: 'board' })
    expect(screen.getByRole('radio', { name: 'Board' })).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('radio', { name: 'List' })).toHaveAttribute('tabindex', '-1')
  })

  it('focus follows the selection while the keyboard is inside the control', () => {
    const { container } = renderControl({ defaultValue: 'board' })
    stubGeometryIn(container, 'List', 0)
    stubGeometryIn(container, 'Board', 70)
    screen.getByRole('radio', { name: 'Board' }).focus()
    fireEvent.keyDown(screen.getByRole('radiogroup', { name: 'Layout' }), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'List' }))
  })

  it('respects a controlled value', () => {
    const { onChange, rerender } = renderControl({ value: 'list' })
    expect(screen.getByRole('radio', { name: 'List' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: 'Board' }))
    expect(onChange).toHaveBeenCalledWith('board')
    expect(screen.getByRole('radio', { name: 'List' })).toHaveAttribute('aria-checked', 'true')
    rerender(<SegmentedControl options={OPTIONS} aria-label="Layout" value="board" onChange={onChange} />)
    expect(screen.getByRole('radio', { name: 'Board' })).toHaveAttribute('aria-checked', 'true')
  })

  it('renders the tablist contract when kind is tabs', () => {
    render(
      <SegmentedControl
        options={[
          { value: 'a', label: 'Alpha', controls: 'panel-a' },
          { value: 'b', label: 'Beta', controls: 'panel-b' },
        ]}
        defaultValue="a"
        kind="tabs"
        aria-label="View"
      />,
    )
    expect(screen.getByRole('tablist', { name: 'View' })).toHaveAttribute('aria-orientation', 'horizontal')
    const alpha = screen.getByRole('tab', { name: 'Alpha' })
    expect(alpha).toHaveAttribute('aria-selected', 'true')
    expect(alpha).toHaveAttribute('aria-controls', 'panel-a')
    expect(screen.getByRole('tab', { name: 'Beta' })).toHaveAttribute('aria-selected', 'false')
  })

  it('disables every option when the control is disabled', () => {
    renderControl({ defaultValue: 'list', disabled: true })
    for (const name of ['List', 'Board', 'Chart']) {
      expect(screen.getByRole('radio', { name })).toBeDisabled()
    }
    expect(screen.getByRole('radiogroup', { name: 'Layout' })).toHaveAttribute('aria-disabled', 'true')
  })

  it('reports the travel direction on the indicator when boxes are measurable', () => {
    const { container } = renderControl({ defaultValue: 'list' })
    stubGeometryIn(container, 'List', 0)
    stubGeometryIn(container, 'Board', 70)
    // The first measured placement is "cold" (it only records the boxes);
    // from the second move on, the pill reports its travel direction.
    fireEvent.click(screen.getByRole('radio', { name: 'Board' }))
    const pill = container.querySelector('.agx-segc__pill') as HTMLElement
    expect(pill.style.left).toBe('70px')
    fireEvent.click(screen.getByRole('radio', { name: 'List' }))
    expect(pill.dataset.dir).toBe('left')
    expect(pill.style.left).toBe('0px')
  })

  it('renders counts and honours option-level disabled state', () => {
    render(
      <SegmentedControl
        options={[
          { value: 'all', label: 'All', count: 12 },
          { value: 'mine', label: 'Mine', disabled: true },
        ]}
        defaultValue="all"
        aria-label="Filter"
      />,
    )
    expect(screen.getByText('12')).toHaveClass('agx-segc__count')
    expect(screen.getByRole('radio', { name: 'Mine' })).toBeDisabled()
  })
})
