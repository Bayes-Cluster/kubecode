import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { WorkspaceNavigationContext, type WorkspaceNavigation } from '../app/location/WorkspaceNavigation'
import { Identity } from './Identity'

describe('Identity', () => {
  it('opens a live member profile from the official link Button inside the official Item', () => {
    const inspect = vi.fn()
    render(
      <WorkspaceNavigationContext.Provider value={{ inspect } as unknown as WorkspaceNavigation}>
        <Identity from="message-1" view={{ key: 'm', memberId: 'member-1', name: 'General', role: 'manager', handle: 'general', roleLabel: 'Project manager' }} />
      </WorkspaceNavigationContext.Provider>,
    )
    const name = screen.getByRole('button', { name: 'General' })
    expect(name).toHaveAttribute('data-slot', 'button')
    expect(name).toHaveAttribute('data-variant', 'link')
    expect(name).toHaveAttribute('data-size', 'inline')
    fireEvent.click(name)
    expect(inspect).toHaveBeenCalledWith({ kind: 'member', id: 'member-1' }, { from: 'message-1' })
    // ADR 0255: the official Item owns the structure; the avatar is its media, the words its description.
    expect(name.closest('[data-slot="item"]')).not.toBeNull()
    expect(screen.getByTestId('member-avatar').closest('[data-slot="item-media"]')).not.toBeNull()
    expect(screen.getByTestId('member-avatar')).toHaveAttribute('data-slot', 'avatar')
    expect(screen.getByTestId('member-avatar')).toHaveAttribute('data-role', 'manager')
    expect(screen.getByText('@general').closest('[data-slot="item-description"]')).not.toBeNull()
  })

  it('is plain text for the researcher, Kubecode and removed members', () => {
    render(<Identity view={{ key: 'r', name: 'You', role: 'researcher' }} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByText('You').closest('[data-slot="item-title"]')).not.toBeNull()
  })
})
