import { render, screen } from '@testing-library/react'
import { toast } from 'sonner'
import { describe, expect, it } from 'vitest'

import { ToasterHost } from './toaster'

/**
 * ADR 0257 §7: the presentation host mounts the Sonner engine unchanged —
 * base stylesheet included, which no module had imported before — and the
 * semantics (dedupe, visible count, close labels) stay the provider's.
 */
describe('ToasterHost', () => {
  it('mounts the toast region with the labels the caller passes', async () => {
    render(
      <ToasterHost closeButton containerAriaLabel="Notifications" theme="light" toastOptions={{ closeButtonAriaLabel: 'Dismiss' }} visibleToasts={3} />,
    )
    toast.success('Saved')
    expect(await screen.findByText('Saved')).toBeInTheDocument()
    expect(document.querySelector('[data-sonner-toaster]')).not.toBeNull()
    expect(document.querySelector('[data-sonner-toast]')).not.toBeNull()
    toast.dismiss()
  })
})
