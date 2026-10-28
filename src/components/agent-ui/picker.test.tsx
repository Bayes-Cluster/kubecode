import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgxPickerEmpty, AgxPickerFill, AgxPickerFoot, AgxPickerGroup, AgxPickerRow } from './picker'

/**
 * ADR 0257 §7: the fill follows the engine's own selection state (read, not
 * restyled), groups label their rows, the footer says the count, and the
 * empty state speaks for the caller.
 */

afterEach(() => {
  document.body.innerHTML = ''
})

function rowAt(index: number, name: string) {
  const row = screen.getByText(name).closest('.agx-pick__row') as HTMLElement
  Object.defineProperty(row, 'offsetTop', { value: index * 33, configurable: true })
  Object.defineProperty(row, 'offsetHeight', { value: 32, configurable: true })
  return row
}

describe('AgxPickerFill', () => {
  it("follows the list's own selection attribute and hides when nothing is selected", async () => {
    render(
      <div className="agx-pick__list">
        <AgxPickerFill />
        <div className="agx-pick__row" data-selected="true">
          <span>Ada</span>
        </div>
        <div className="agx-pick__row">
          <span>Grace</span>
        </div>
      </div>,
    )
    // One frame in, the fill sits on the selected row.
    rowAt(0, 'Ada')
    await waitFor(() => expect(document.querySelector('.agx-pick__fill')).toHaveAttribute('data-lit'))
    const fill = document.querySelector('.agx-pick__fill') as HTMLElement

    // cmdk moves selection by flipping attributes; the fill reads them.
    const ada = screen.getByText('Ada').closest('.agx-pick__row') as HTMLElement
    const grace = rowAt(1, 'Grace')
    ada.removeAttribute('data-selected')
    grace.setAttribute('data-selected', 'true')
    await waitFor(() => expect(fill.style.transform).toBe('translateY(33px)'))
    expect(fill.style.height).toBe('32px')

    // No selection anywhere: the fill fades out.
    grace.removeAttribute('data-selected')
    await waitFor(() => expect(fill).not.toHaveAttribute('data-lit'))
  })

  it('tracks a custom selector, as the Radix menus need', async () => {
    render(
      <div className="agx-pick__list">
        <AgxPickerFill selector="[data-highlighted]" />
        <div className="agx-pick__row" data-highlighted="">
          <span>Ada</span>
        </div>
      </div>,
    )
    rowAt(0, 'Ada')
    await waitFor(() => expect(document.querySelector('.agx-pick__fill')).toHaveAttribute('data-lit'))
  })

  it('follows a selection that arrives with a freshly rendered row', async () => {
    render(
      <div className="agx-pick__list">
        <AgxPickerFill />
        <div className="agx-pick__row">
          <span>Ada</span>
        </div>
      </div>,
    )
    // A disjoint candidate set swaps the rows themselves, not attributes.
    const list = document.querySelector('.agx-pick__list') as HTMLElement
    list.querySelector('.agx-pick__row')?.remove()
    const born = document.createElement('div')
    born.className = 'agx-pick__row'
    born.setAttribute('data-selected', 'true')
    born.innerHTML = '<span>Grace</span>'
    Object.defineProperty(born, 'offsetTop', { value: 66, configurable: true })
    Object.defineProperty(born, 'offsetHeight', { value: 32, configurable: true })
    list.append(born)
    await waitFor(() =>
      expect(document.querySelector('.agx-pick__fill')?.style.transform).toBe('translateY(66px)'),
    )
  })

  it('disconnects its observers when it unmounts', async () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect')
    const resizeDisconnect = vi.spyOn(ResizeObserver.prototype, 'disconnect')
    const view = render(
      <div className="agx-pick__list">
        <AgxPickerFill />
        <div className="agx-pick__row" data-selected="true">
          <span>Ada</span>
        </div>
      </div>,
    )
    await waitFor(() => expect(document.querySelector('.agx-pick__fill')).toHaveAttribute('data-lit'))
    view.unmount()
    expect(disconnect).toHaveBeenCalled()
    expect(resizeDisconnect).toHaveBeenCalled()
  })
})

describe('AgxPickerGroup and AgxPickerRow', () => {
  it('labels a group and rows render name, hint and check', () => {
    render(
      <AgxPickerGroup label="Members">
        <div className="agx-pick__row" aria-selected="true">
          <AgxPickerRow hint="@ada" name="Ada" />
        </div>
        <div className="agx-pick__row">
          <AgxPickerRow name="Grace" />
        </div>
      </AgxPickerGroup>,
    )
    expect(screen.getByText('Members')).toHaveClass('agx-pick__group-label')
    expect(screen.getByText('Ada')).toHaveClass('agx-pick__name')
    expect(screen.getByText('@ada')).toHaveClass('agx-pick__hint')
    expect(screen.getAllByText(/Ada|Grace/).length).toBe(2)
    // The check rides every row; selection shows it through the stylesheet.
    expect(document.querySelectorAll('.agx-pick__check').length).toBe(2)
  })
})

describe('AgxPickerFoot', () => {
  it('announces the count politely and shows the keys', () => {
    render(<AgxPickerFoot count="3 of 12" keys={<kbd>↵</kbd>} />)
    expect(screen.getByRole('status')).toHaveTextContent('3 of 12')
    expect(screen.getByText('↵').closest('span')).toHaveClass('agx-pick__keys')
  })

  it('is nothing when there is nothing to say', () => {
    const { container } = render(<AgxPickerFoot />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('AgxPickerEmpty', () => {
  it('speaks for the caller', () => {
    render(<AgxPickerEmpty>No members match</AgxPickerEmpty>)
    expect(screen.getByText('No members match')).toHaveClass('agx-pick__empty')
  })
})
