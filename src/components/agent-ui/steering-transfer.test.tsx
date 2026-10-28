import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { STEERING_LANDED_ATTRIBUTE, useSteeringTransfer } from './steering-transfer'

/**
 * ADR 0257 §7: the transfer glides the confirmed receipt from the queue
 * row's last box (explicit client-message-id identity), sets the landed
 * highlight, cleans up on unmount, and under reduced motion lands in the
 * same final state without the glide.
 */

const tick = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 40))
})

function Harness({ id }: { id: string }) {
  const { request, source } = useSteeringTransfer()
  return (
    <div>
      <div data-testid="queue-row" ref={source(id)}>queued prompt</div>
      <button type="button" onClick={() => request(id)}>confirm</button>
    </div>
  )
}

describe('useSteeringTransfer', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('lands the receipt with the highlight and clears it after the window', async () => {
    const { container, getByRole } = render(<Harness id="cm-1" />)
    container.querySelector('[data-testid="receipt-row"]')?.remove()
    await tick()
    act(() => {
      getByRole('button', { name: 'confirm' }).click()
    })
    // The receipt mounts a moment after the queue row is gone.
    const receipt = document.createElement('div')
    receipt.setAttribute('data-message-id', 'cm-1')
    receipt.setAttribute('data-testid', 'receipt-row')
    container.appendChild(receipt)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
    })
    expect(receipt).toHaveAttribute(STEERING_LANDED_ATTRIBUTE)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1300))
    })
    expect(receipt.hasAttribute(STEERING_LANDED_ATTRIBUTE)).toBe(false)
  })

  it('lands without the glide under reduced motion', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }),
    )
    const animate = vi.fn()
    HTMLElement.prototype.animate = vi.fn(function (this: HTMLElement) {
      animate()
      return { cancel: () => {}, finished: Promise.resolve() } as unknown as Animation
    })
    const { container, getByRole } = render(<Harness id="cm-2" />)
    await tick()
    act(() => {
      getByRole('button', { name: 'confirm' }).click()
    })
    const receipt = document.createElement('div')
    receipt.setAttribute('data-message-id', 'cm-2')
    container.appendChild(receipt)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
    })
    expect(receipt).toHaveAttribute(STEERING_LANDED_ATTRIBUTE)
    expect(animate).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('plays nothing when the vanishing item had no confirmed receipt', async () => {
    const animate = vi.fn()
    HTMLElement.prototype.animate = vi.fn(function (this: HTMLElement) {
      animate()
      return { cancel: () => {}, finished: Promise.resolve() } as unknown as Animation
    })
    const { container, getByRole } = render(<Harness id="cm-3" />)
    await tick()
    act(() => {
      getByRole('button', { name: 'confirm' }).click()
    })
    // No receipt ever mounts: the item was removed, not admitted.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900))
    })
    expect(animate).not.toHaveBeenCalled()
    expect(container.querySelectorAll('[data-steering-landed]')).toHaveLength(0)
  })
})
