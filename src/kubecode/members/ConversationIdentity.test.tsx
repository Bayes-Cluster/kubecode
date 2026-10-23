import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { WorkspaceNavigationContext, type WorkspaceNavigation } from '../app/location/WorkspaceNavigation'
import { ConversationIdentity } from './ConversationIdentity'

describe('ConversationIdentity', () => {
  it('opens a live member profile from the official link Button, like MemberIdentity', () => {
    const inspect = vi.fn()
    render(
      <WorkspaceNavigationContext.Provider value={{ inspect } as unknown as WorkspaceNavigation}>
        <ConversationIdentity from="message-1" view={{ key: 'm', memberId: 'member-1', name: 'General', role: 'manager' }} />
      </WorkspaceNavigationContext.Provider>,
    )
    const name = screen.getByRole('button', { name: 'General' })
    expect(name).toHaveAttribute('data-slot', 'button')
    expect(name).toHaveAttribute('data-variant', 'link')
    fireEvent.click(name)
    expect(inspect).toHaveBeenCalledWith({ kind: 'member', id: 'member-1' }, { from: 'message-1' })
    // The shared MemberAvatar: one avatar for every identity.
    expect(screen.getByTestId('member-avatar')).toHaveAttribute('data-slot', 'avatar')
    expect(screen.getByTestId('member-avatar')).toHaveAttribute('data-role', 'manager')
  })
})
