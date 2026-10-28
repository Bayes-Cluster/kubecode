import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import { SystemMessageProvider } from '../system-messages'
import { useNotificationOnboardingToast } from './useNotificationOnboardingToast'

const t = createTranslator('en')

function Host({ onDismiss, onEnable, open }: { open: boolean; onDismiss: () => void; onEnable: () => void }) {
  useNotificationOnboardingToast({ onDismiss, onEnable, open, t })
  return null
}

function mount(open = true) {
  const onDismiss = vi.fn()
  const onEnable = vi.fn()
  const view = render(
    <SystemMessageProvider closeLabel="Close" regionLabel="Notifications">
      <Host open={open} onDismiss={onDismiss} onEnable={onEnable} />
    </SystemMessageProvider>,
  )
  const rerender = (next: boolean) => view.rerender(
    <SystemMessageProvider closeLabel="Close" regionLabel="Notifications">
      <Host open={next} onDismiss={onDismiss} onEnable={onEnable} />
    </SystemMessageProvider>,
  )
  return { onDismiss, onEnable, rerender }
}

const title = () => screen.queryByText('Stay informed when Agents finish or need input')

describe('useNotificationOnboardingToast (ADR 0256)', () => {
  it('records nothing when the app closes the toast itself', async () => {
    const { onDismiss, rerender } = mount()
    expect(await screen.findByText('Stay informed when Agents finish or need input')).toBeInTheDocument()
    rerender(false)
    await waitFor(() => expect(title()).toBeNull())
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('records the choice once when the researcher closes it, and once for Not now', async () => {
    const first = mount()
    await screen.findByText('Stay informed when Agents finish or need input')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(first.onDismiss).toHaveBeenCalledTimes(1))
    // The app then closes the (already closing) toast: still one record.
    first.rerender(false)
    await waitFor(() => expect(title()).toBeNull())
    expect(first.onDismiss).toHaveBeenCalledTimes(1)
    expect(first.onEnable).not.toHaveBeenCalled()
  })

  it('leaves Enable to its own handler and records no dismissal for it', async () => {
    const { onDismiss, onEnable, rerender } = mount()
    await screen.findByText('Stay informed when Agents finish or need input')
    fireEvent.click(screen.getByRole('button', { name: 'Enable notifications' }))
    expect(onEnable).toHaveBeenCalledTimes(1)
    rerender(false)
    await waitFor(() => expect(title()).toBeNull())
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('records Not now once', async () => {
    const { onDismiss } = mount()
    await screen.findByText('Stay informed when Agents finish or need input')
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(title()).toBeNull())
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
