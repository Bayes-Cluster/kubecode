import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import { fakeNavigation } from '../app/inspector/inspectorTesting'
import { WorkspaceNavigationContext } from '../app/location/WorkspaceNavigation'
import { Identity } from './Identity'
import { analyst, writer } from './memberFixtures'
import { memberView } from './memberIdentity'

const t = createTranslator('en')

describe('Identity', () => {
  it('opens a live member’s profile from the name and returns focus where it came from', () => {
    const navigation = fakeNavigation()
    render(
      <WorkspaceNavigationContext.Provider value={navigation}>
        <Identity from="message:m1" view={memberView(analyst, t)} />
      </WorkspaceNavigationContext.Provider>,
    )
    expect(screen.getByText('@analyst')).toBeInTheDocument()
    expect(screen.getByText('Specialist · Analysis')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Analyst' }))
    expect(navigation.inspect).toHaveBeenCalledWith({ kind: 'member', id: 'a' }, { from: 'message:m1' })
  })

  it('is plain text for a removed member, and outside the shell', () => {
    const navigation = fakeNavigation()
    render(
      <WorkspaceNavigationContext.Provider value={navigation}>
        <Identity view={memberView({ ...writer, state: 'removed' }, t)} />
      </WorkspaceNavigationContext.Provider>,
    )
    expect(screen.queryByRole('button', { name: 'Writer' })).not.toBeInTheDocument()
    expect(screen.getByText('Removed')).toBeInTheDocument()
    render(<Identity view={memberView(analyst, t)} />)
    expect(screen.queryByRole('button', { name: 'Analyst' })).not.toBeInTheDocument()
  })
})
